package main

import (
	"encoding/hex"
	"encoding/json"
	"hash/fnv"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxPortOccupancyListeners = 256
const maxPortOccupancyBytes = 32 * 1024

type portOccupancyListener struct {
	Port           int    `json:"port"`
	Protocol       string `json:"protocol"`
	Address        string `json:"address"`
	Process        string `json:"process,omitempty"`
	ManagedRuntime string `json:"managedRuntime,omitempty"`
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

func listenerPriority(listener portOccupancyListener) int {
	if listener.ManagedRuntime != "" {
		return 0
	}
	if listener.Port == 80 || listener.Port == 443 || listener.Port >= 10000 && listener.Port < 49152 {
		return 1
	}
	if listener.Port < 49152 {
		return 2
	}
	return 3
}

type portOccupancyPayload struct {
	Listeners      []portOccupancyListener `json:"listeners"`
	CollectedAt    int64                   `json:"collectedAt"`
	Complete       bool                    `json:"complete"`
	CoveredThrough int                     `json:"coveredThrough,omitempty"`
}

func portOccupancyFromListen(snapshot *runtimeListenSnapshot) portOccupancyPayload {
	result := portOccupancyPayload{Listeners: []portOccupancyListener{}, Complete: true}
	if snapshot == nil || !snapshot.usable {
		return result
	}
	result.CollectedAt = snapshot.collectedAt.UnixMilli()
	if result.CollectedAt <= 0 {
		result.CollectedAt = time.Now().UnixMilli()
	}
	for protocol, ports := range map[string]map[int][]string{"tcp": snapshot.tcpPorts, "udp": snapshot.udpPorts} {
		for port, lines := range ports {
			for _, line := range lines {
				fields := strings.Fields(line)
				address := "unknown"
				if len(fields) >= 5 {
					endpoint := fields[4]
					if index := strings.LastIndex(endpoint, ":"); index >= 0 {
						address = strings.Trim(endpoint[:index], "[]")
					}
				} else if procAddress := procNetListenAddress(line); procAddress != "" {
					address = procAddress
				} else {
					result.Complete = false
				}
				process := ssListenerProcess(line)
				if len(address) > 128 {
					address = address[:128]
				}
				if len(process) > 128 {
					process = process[:128]
				}
				result.Listeners = append(result.Listeners, portOccupancyListener{
					Port: port, Protocol: protocol, Address: address, Process: process,
					ManagedRuntime: managedRuntimeForListener(line, process),
				})
			}
		}
	}
	sort.Slice(result.Listeners, func(i, j int) bool {
		a, b := result.Listeners[i], result.Listeners[j]
		if listenerPriority(a) != listenerPriority(b) {
			return listenerPriority(a) < listenerPriority(b)
		}
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
	all := result.Listeners
	bytesUsed := 128
	limit := 0
	for limit < len(all) && limit < maxPortOccupancyListeners {
		encoded, _ := json.Marshal(all[limit])
		if bytesUsed+len(encoded)+1 > maxPortOccupancyBytes {
			break
		}
		bytesUsed += len(encoded) + 1
		limit++
	}
	if limit < len(all) {
		result.Complete = false
		result.Listeners = all[:limit]
		firstOmittedPort := all[limit].Port
		for _, listener := range all[limit+1:] {
			if listener.Port < firstOmittedPort {
				firstOmittedPort = listener.Port
			}
		}
		result.CoveredThrough = firstOmittedPort - 1
	}
	sort.Slice(result.Listeners, func(i, j int) bool {
		a, b := result.Listeners[i], result.Listeners[j]
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
	return result
}

func portOccupancySignature(snapshot portOccupancyPayload) string {
	contents, _ := json.Marshal(struct {
		Listeners      []portOccupancyListener `json:"listeners"`
		Complete       bool                    `json:"complete"`
		CoveredThrough int                     `json:"coveredThrough"`
	}{snapshot.Listeners, snapshot.Complete, snapshot.CoveredThrough})
	h := fnv.New64a()
	_, _ = h.Write(contents)
	return strconv.FormatUint(h.Sum64(), 16)
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
