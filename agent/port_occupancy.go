package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"hash/fnv"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxPortOccupancyListeners = 256
const maxPortOccupancyBytes = 16 * 1024
const maxPortOccupancyEnvelopeBytes = 9 * 1024 * 1024

type portOccupancyListener struct {
	Port             int    `json:"port"`
	Protocol         string `json:"protocol"`
	Address          string `json:"address"`
	Process          string `json:"process,omitempty"`
	ManagedRuntime   string `json:"managedRuntime,omitempty"`
	ManagedRuntimeID string `json:"managedRuntimeId,omitempty"`
}

var ssProcessIDPattern = regexp.MustCompile(`\bpid=([0-9]+)\b`)
var managedPortServicePattern = regexp.MustCompile(`/forwardx-(realm|socat)-(?:tcp-|udp-|both-)?[0-9]{1,5}\.service(?:/|\s|$)`)

func managedRuntimeFromCgroup(text string) string {
	for _, service := range []string{runtimeServiceName, tunnelRuntimeServiceName, nginxServiceName} {
		if strings.Contains(text, "/"+service+".service") {
			return service
		}
	}
	if match := managedPortServicePattern.FindStringSubmatch(text); len(match) > 1 {
		return "forwardx-" + match[1]
	}
	return ""
}

func managedRuntimeForListener(line string, process string) string {
	match := ssProcessIDPattern.FindStringSubmatch(line)
	if len(match) < 2 {
		return ""
	}
	pid, err := strconv.Atoi(match[1])
	if err != nil || pid <= 0 {
		return ""
	}
	if process == "forwardx-fxp" {
		fxpMu.Lock()
		defer fxpMu.Unlock()
		for _, tracked := range fxpServers {
			if tracked != nil && tracked.cmd != nil && tracked.cmd.Process != nil && tracked.cmd.Process.Pid == pid {
				return "forwardx-fxp"
			}
		}
		return ""
	}
	if process != "gost" && process != "forwardx-runtim" && process != "forwardx-runtime" &&
		process != "nginx" && process != "realm" && process != "socat" {
		return ""
	}
	cgroup, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return ""
	}
	service := managedRuntimeFromCgroup(string(cgroup))
	if (service == "forwardx-realm") != (process == "realm") ||
		(service == "forwardx-socat") != (process == "socat") {
		return ""
	}
	return service
}

func managedRuntimeIDForListener(line string, process string) string {
	if process != "forwardx-fxp" {
		return ""
	}
	match := ssProcessIDPattern.FindStringSubmatch(line)
	if len(match) < 2 {
		return ""
	}
	pid, err := strconv.Atoi(match[1])
	if err != nil || pid <= 0 {
		return ""
	}
	fxpMu.Lock()
	defer fxpMu.Unlock()
	for id, tracked := range fxpServers {
		if tracked != nil && tracked.cmd != nil && tracked.cmd.Process != nil && tracked.cmd.Process.Pid == pid {
			return id
		}
	}
	return ""
}

func procNetListenAddress(line string) string {
	path, endpoint, found := strings.Cut(line, ":")
	if !found || !strings.HasPrefix(path, "/proc/net/") {
		return ""
	}
	hexAddress, _, found := strings.Cut(endpoint, ":")
	if !found || (len(hexAddress) != 8 && len(hexAddress) != 32) {
		return ""
	}
	bytes, err := hex.DecodeString(hexAddress)
	if err != nil {
		return ""
	}
	for offset := 0; offset < len(bytes); offset += 4 {
		bytes[offset], bytes[offset+3] = bytes[offset+3], bytes[offset]
		bytes[offset+1], bytes[offset+2] = bytes[offset+2], bytes[offset+1]
	}
	return net.IP(bytes).String()
}

func ssListenerProcess(line string) string {
	if index := strings.Index(line, "users:((\""); index >= 0 {
		start := index + len("users:((\"")
		if end := strings.IndexByte(line[start:], '"'); end >= 0 {
			return line[start : start+end]
		}
	}
	return ""
}

type portOccupancyPayload struct {
	Listeners   []portOccupancyListener `json:"listeners"`
	Covered     []portOccupancyPort     `json:"covered"`
	CollectedAt int64                   `json:"collectedAt"`
}

type portOccupancyPort struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

type portRuleEntry struct {
	RuleID      int    `json:"ruleId"`
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"`
	ForwardType string `json:"forwardType"`
}

var portRuleManifestMu sync.Mutex
var portRuleManifestRevision int64 = -1
var portRuleManifestSignature string
var portRuleManifestEntries []portRuleEntry

func signPortRuleManifest(entries []portRuleEntry) string {
	var content strings.Builder
	for _, entry := range entries {
		content.WriteString(strconv.Itoa(entry.RuleID) + ":" + strconv.Itoa(entry.Port) + ":" + entry.Protocol + ":" + entry.ForwardType + "\n")
	}
	digest := sha256.Sum256([]byte(content.String()))
	return hex.EncodeToString(digest[:])
}

func acceptPortRuleManifest(revision int64, signature string, entries *[]portRuleEntry) {
	portRuleManifestMu.Lock()
	defer portRuleManifestMu.Unlock()
	if revision < 0 || revision < portRuleManifestRevision {
		return
	}
	portRuleManifestRevision = revision
	if entries == nil && signature == portRuleManifestSignature && signature != "" {
		return
	}
	valid := entries != nil && len(signature) == 64
	if valid {
		for _, entry := range *entries {
			if entry.RuleID <= 0 || entry.Port < 1 || entry.Port > 65535 ||
				(entry.Protocol != "tcp" && entry.Protocol != "udp" && entry.Protocol != "both") || entry.ForwardType == "" {
				valid = false
				break
			}
		}
		valid = valid && signPortRuleManifest(*entries) == signature
	}
	if valid {
		portRuleManifestEntries = append([]portRuleEntry{}, (*entries)...)
		portRuleManifestSignature = signature
	} else {
		portRuleManifestEntries = nil
		portRuleManifestSignature = ""
	}
	portOccupancyMu.Lock()
	forceSendPortOccupancy = true
	portOccupancyMu.Unlock()
}

func portRuleManifestForHeartbeat() (string, []portRuleEntry) {
	portRuleManifestMu.Lock()
	defer portRuleManifestMu.Unlock()
	return portRuleManifestSignature, append([]portRuleEntry{}, portRuleManifestEntries...)
}

func portOccupancyFromListen(snapshot *runtimeListenSnapshot, rules []portRuleEntry) portOccupancyPayload {
	result := portOccupancyPayload{Listeners: []portOccupancyListener{}, Covered: []portOccupancyPort{}}
	if snapshot == nil || !snapshot.usable {
		return result
	}
	result.CollectedAt = snapshot.collectedAt.UnixMilli()
	if result.CollectedAt <= 0 {
		result.CollectedAt = time.Now().UnixMilli()
	}
	requested := map[int]map[string]bool{}
	for _, rule := range rules {
		if rule.Port < 1 || rule.Port > 65535 {
			continue
		}
		if requested[rule.Port] == nil {
			requested[rule.Port] = map[string]bool{}
		}
		if rule.Protocol == "tcp" || rule.Protocol == "both" {
			requested[rule.Port]["tcp"] = true
		}
		if rule.Protocol == "udp" || rule.Protocol == "both" {
			requested[rule.Port]["udp"] = true
		}
	}
	ports := make([]int, 0, len(requested))
	for port := range requested {
		ports = append(ports, port)
	}
	sort.Ints(ports)
	for _, port := range ports {
		group := []portOccupancyListener{}
		coverage := []portOccupancyPort{}
		valid := true
		for _, source := range []struct {
			protocol string
			lines    map[int][]string
		}{{"tcp", snapshot.tcpPorts}, {"udp", snapshot.udpPorts}} {
			if !requested[port][source.protocol] {
				continue
			}
			coverage = append(coverage, portOccupancyPort{Port: port, Protocol: source.protocol})
			for _, line := range source.lines[port] {
				fields := strings.Fields(line)
				address := ""
				if len(fields) >= 5 {
					endpoint := fields[4]
					if index := strings.LastIndex(endpoint, ":"); index >= 0 {
						address = strings.Trim(endpoint[:index], "[]")
					}
				} else if procAddress := procNetListenAddress(line); procAddress != "" {
					address = procAddress
				}
				if address == "" {
					valid = false
					break
				}
				process := ssListenerProcess(line)
				if len(address) > 128 {
					address = address[:128]
				}
				if len(process) > 128 {
					process = process[:128]
				}
				managedRuntime := managedRuntimeForListener(line, process)
				managedRuntimeID := ""
				if managedRuntime == "forwardx-fxp" {
					managedRuntimeID = managedRuntimeIDForListener(line, process)
				}
				group = append(group, portOccupancyListener{
					Port: port, Protocol: source.protocol, Address: address, Process: process,
					ManagedRuntime:   managedRuntime,
					ManagedRuntimeID: managedRuntimeID,
				})
			}
		}
		if !valid || len(result.Listeners)+len(group) > maxPortOccupancyListeners {
			continue
		}
		sort.Slice(group, func(i, j int) bool {
			a, b := group[i], group[j]
			if a.Port != b.Port {
				return a.Port < b.Port
			}
			if a.Protocol != b.Protocol {
				return a.Protocol < b.Protocol
			}
			if a.Address != b.Address {
				return a.Address < b.Address
			}
			return a.Process < b.Process
		})
		candidate := portOccupancyPayload{
			Listeners:   append(append([]portOccupancyListener{}, result.Listeners...), group...),
			Covered:     append(append([]portOccupancyPort{}, result.Covered...), coverage...),
			CollectedAt: result.CollectedAt,
		}
		encoded, _ := json.Marshal(candidate)
		if len(encoded) > maxPortOccupancyBytes {
			continue
		}
		result = candidate
	}
	return result
}

func portOccupancySignature(snapshot portOccupancyPayload) string {
	contents, _ := json.Marshal(struct {
		Listeners []portOccupancyListener `json:"listeners"`
		Covered   []portOccupancyPort     `json:"covered"`
	}{snapshot.Listeners, snapshot.Covered})
	h := fnv.New64a()
	_, _ = h.Write(contents)
	return strconv.FormatUint(h.Sum64(), 16)
}

func fitPortOccupancyRequest(payload map[string]any) {
	snapshot, ok := payload["portOccupancy"].(*portOccupancyPayload)
	if !ok || snapshot == nil {
		return
	}
	for len(snapshot.Covered) > 0 {
		plain, _ := json.Marshal(payload)
		if 2*len(plain)+256 <= maxPortOccupancyEnvelopeBytes {
			break
		}
		lastPort := snapshot.Covered[len(snapshot.Covered)-1].Port
		for len(snapshot.Covered) > 0 && snapshot.Covered[len(snapshot.Covered)-1].Port == lastPort {
			snapshot.Covered = snapshot.Covered[:len(snapshot.Covered)-1]
		}
		kept := snapshot.Listeners[:0]
		for _, listener := range snapshot.Listeners {
			if listener.Port != lastPort {
				kept = append(kept, listener)
			}
		}
		snapshot.Listeners = kept
	}
	signature := portOccupancySignature(*snapshot)
	payload["portOccupancySignature"] = signature
	portOccupancyMu.Lock()
	lastPortOccupancySignature = signature
	portOccupancyMu.Unlock()
}

func portBindFailureMessage(snapshot *runtimeListenSnapshot, port int, protocol string) string {
	if snapshot == nil || !snapshot.usable || port <= 0 {
		return ""
	}
	for _, entries := range []struct {
		name  string
		lines map[int][]string
	}{{"tcp", snapshot.tcpPorts}, {"udp", snapshot.udpPorts}} {
		if protocol != "both" && protocol != entries.name {
			continue
		}
		for _, line := range entries.lines[port] {
			if process := ssListenerProcess(line); process != "" {
				return "port " + strconv.Itoa(port) + " occupied by " + process
			}
			return "port " + strconv.Itoa(port) + " occupied"
		}
	}
	return ""
}

func bindFailureMessage(message string, port int, protocol string, snapshot *runtimeListenSnapshot) string {
	lower := strings.ToLower(message)
	bindFailed := strings.Contains(lower, "address already in use") || strings.Contains(lower, "listen port still busy")
	if !bindFailed && message != "" {
		return message
	}
	if occupied := portBindFailureMessage(snapshot, port, protocol); occupied != "" {
		return occupied
	}
	if bindFailed && port > 0 {
		return "port " + strconv.Itoa(port) + " occupied"
	}
	return message
}
