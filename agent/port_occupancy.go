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
				process := ""
				if index := strings.Index(line, "users:((\""); index >= 0 {
					start := index + len("users:((\"")
					if end := strings.IndexByte(line[start:], '"'); end >= 0 {
						process = line[start : start+end]
					}
				}
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
		if limit > 0 {
			result.CoveredThrough = all[limit-1].Port - 1
		}
	}
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
	for _, listener := range portOccupancyFromListen(snapshot).Listeners {
		if listener.Port != port || protocol != "both" && listener.Protocol != protocol {
			continue
		}
		if listener.Process != "" {
			return "port " + strconv.Itoa(port) + " occupied by " + listener.Process
		}
		return "port " + strconv.Itoa(port) + " occupied"
	}
	return ""
}
