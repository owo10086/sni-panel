package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

func TestPortOccupancySnapshotPreservesListenerDetails(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	listen.parseSSListenOutput("tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:* users:((\"code\",pid=518917,fd=8))\n" +
		"tcp LISTEN 0 128 [::1]:11127 [::]:* users:((\"proxy\",pid=2,fd=4))\n" +
		"udp UNCONN 0 0 0.0.0.0:11127 0.0.0.0:* users:((\"dns\",pid=3,fd=4))")
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{{RuleID: 1, Port: 11127, Protocol: "both", ForwardType: "iptables"}})
	if len(snapshot.Covered) != 2 || len(snapshot.Listeners) != 3 {
		t.Fatalf("unexpected listener snapshot: %+v", snapshot)
	}
	if snapshot.Listeners[0].Address != "127.0.0.1" || snapshot.Listeners[0].Process != "code" || snapshot.Listeners[0].Protocol != "tcp" {
		t.Fatalf("TCP IPv4 listener lost details: %+v", snapshot.Listeners[0])
	}
	if snapshot.Listeners[1].Address != "::1" || snapshot.Listeners[2].Protocol != "udp" {
		t.Fatalf("IPv6 and UDP listeners lost details: %+v", snapshot.Listeners)
	}
	if snapshot.CollectedAt <= 0 || strings.Contains(portOccupancySignature(snapshot), "pid=") {
		t.Fatal("invalid snapshot timestamp or signature")
	}
	copy := snapshot
	copy.CollectedAt++
	if portOccupancySignature(copy) != portOccupancySignature(snapshot) {
		t.Fatal("collection time changed the listener content signature")
	}
}

func TestPortOccupancyTracksFXPInstance(t *testing.T) {
	fxpMu.Lock()
	previous := fxpServers
	fxpServers = map[string]*fxpProcess{
		"entry-group:v1:42": {cmd: &exec.Cmd{Process: &os.Process{Pid: 919191}}},
	}
	fxpMu.Unlock()
	t.Cleanup(func() {
		fxpMu.Lock()
		fxpServers = previous
		fxpMu.Unlock()
	})
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	listen.parseSSListenOutput("tcp LISTEN 0 128 0.0.0.0:11127 0.0.0.0:* users:((\"forwardx-fxp\",pid=919191,fd=8))")
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{{RuleID: 1, Port: 11127, Protocol: "tcp", ForwardType: "gost"}})
	if len(snapshot.Listeners) != 1 || snapshot.Listeners[0].ManagedRuntimeID != "entry-group:v1:42" {
		t.Fatalf("FXP listener instance was not identified: %+v", snapshot.Listeners)
	}
	other := snapshot
	other.Listeners = append([]portOccupancyListener(nil), snapshot.Listeners...)
	other.Listeners[0].ManagedRuntimeID = "entry-group:v1:43"
	if portOccupancySignature(snapshot) == portOccupancySignature(other) {
		t.Fatal("FXP instance change did not update the snapshot signature")
	}
}

func TestPortOccupancySnapshotDropsEntirePortWhenListenerLimitReached(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	for idx := 0; idx < 257; idx++ {
		listen.add("tcp", 11127, "tcp LISTEN 0 128 0.0.0.0:11127 0.0.0.0:* users:((\"service\",pid=1,fd=1))")
	}
	listen.add("tcp", 11128, "tcp LISTEN 0 128 127.0.0.1:11128 0.0.0.0:*")
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{
		{RuleID: 1, Port: 11127, Protocol: "tcp", ForwardType: "gost"},
		{RuleID: 2, Port: 11128, Protocol: "tcp", ForwardType: "iptables"},
	})
	if len(snapshot.Covered) != 1 || snapshot.Covered[0].Port != 11128 || len(snapshot.Listeners) != 1 {
		t.Fatalf("oversized port must leave coverage as a whole: %+v", snapshot)
	}
}

func TestPortOccupancySnapshotListenerLimitAppliesPerPort(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	for idx := 0; idx < 255; idx++ {
		listen.add("tcp", 11127, "tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:*")
	}
	for idx := 0; idx < 2; idx++ {
		listen.add("tcp", 11128, "tcp LISTEN 0 128 127.0.0.1:11128 0.0.0.0:*")
	}
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{
		{RuleID: 1, Port: 11127, Protocol: "tcp", ForwardType: "iptables"},
		{RuleID: 2, Port: 11128, Protocol: "tcp", ForwardType: "iptables"},
	})
	encoded, _ := json.Marshal(snapshot)
	if len(encoded) > maxPortOccupancyBytes {
		t.Fatalf("test snapshot exceeded the overall byte limit: %d", len(encoded))
	}
	if len(snapshot.Covered) != 2 || len(snapshot.Listeners) != 257 || snapshot.Covered[0].Port != 11127 || snapshot.Covered[1].Port != 11128 {
		t.Fatalf("per-port listener limit discarded a complete port: %+v", snapshot.Covered)
	}
}

func TestPortOccupancySnapshotDropsEntirePortWhenByteLimitReached(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	process := strings.Repeat("p", 100)
	for idx := 0; idx < 200; idx++ {
		listen.add("tcp", 11127, "tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:* users:((\""+process+"\",pid=1,fd=1))")
	}
	listen.add("tcp", 11128, "tcp LISTEN 0 128 127.0.0.1:11128 0.0.0.0:*")
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{
		{RuleID: 1, Port: 11127, Protocol: "tcp", ForwardType: "iptables"},
		{RuleID: 2, Port: 11128, Protocol: "tcp", ForwardType: "iptables"},
	})
	if len(snapshot.Covered) != 1 || snapshot.Covered[0].Port != 11128 || len(snapshot.Listeners) != 1 {
		t.Fatalf("byte limit retained part of an oversized port: %+v", snapshot)
	}
}

func TestPortOccupancySnapshotIgnoresUnrelatedListeners(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	for port := 1; port <= 300; port++ {
		listen.add("tcp", port, "tcp LISTEN 0 128 0.0.0.0:1 0.0.0.0:*")
	}
	listen.add("tcp", 11127, "tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:* users:((\"code\",pid=518917,fd=8))")
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{{RuleID: 1, Port: 11127, Protocol: "tcp", ForwardType: "iptables"}})
	if len(snapshot.Covered) != 1 || snapshot.Covered[0].Port != 11127 || len(snapshot.Listeners) != 1 {
		t.Fatalf("unrelated listeners changed rule coverage: %+v", snapshot)
	}
}

func TestPortOccupancySnapshotDecodesProcNetAddresses(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	listen.add("tcp", 11127, "/proc/net/tcp:0100007F:2B77")
	listen.add("tcp", 11128, "/proc/net/tcp6:00000000000000000000000001000000:2B78")
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{
		{RuleID: 1, Port: 11127, Protocol: "tcp", ForwardType: "gost"},
		{RuleID: 2, Port: 11128, Protocol: "tcp", ForwardType: "gost"},
	})
	if len(snapshot.Covered) != 2 || len(snapshot.Listeners) != 2 ||
		snapshot.Listeners[0].Address != "127.0.0.1" || snapshot.Listeners[1].Address != "::1" {
		t.Fatalf("/proc/net addresses were not preserved: %+v", snapshot)
	}
}

func TestFallbackCollectionDoesNotClaimCoverageWhenOneAddressFamilyFails(t *testing.T) {
	snapshot := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}}
	snapshot.parseProcNetListenFilesWith(func(path string) ([]byte, error) {
		if path == "/proc/net/tcp6" {
			return nil, errors.New("permission denied")
		}
		return []byte("header\n  0: 0100007F:2B77 00000000:0000 0A\n"), nil
	})
	result := portOccupancyFromListen(snapshot, []portRuleEntry{{RuleID: 1, Port: 11127, Protocol: "both"}})
	if snapshot.usable || len(result.Covered) != 0 || len(result.Listeners) != 0 {
		t.Fatalf("partially read fallback declared coverage: %+v %+v", snapshot, result)
	}
}

func TestPortRuleManifestRevisionAndRecovery(t *testing.T) {
	portRuleManifestMu.Lock()
	previousRevision, previousSignature, previousEntries := portRuleManifestRevision, portRuleManifestSignature, portRuleManifestEntries
	portRuleManifestRevision, portRuleManifestSignature, portRuleManifestEntries = -1, "", nil
	portRuleManifestMu.Unlock()
	t.Cleanup(func() {
		portRuleManifestMu.Lock()
		portRuleManifestRevision, portRuleManifestSignature, portRuleManifestEntries = previousRevision, previousSignature, previousEntries
		portRuleManifestMu.Unlock()
	})
	entries := []portRuleEntry{{RuleID: 1, Port: 11127, Protocol: "tcp", ForwardType: "gost"}}
	signature := signPortRuleManifest(entries)
	acceptPortRuleManifest(10, signature, &entries)
	if current, rules := portRuleManifestForHeartbeat(); current != signature || len(rules) != 1 {
		t.Fatalf("valid manifest was not applied: %q %+v", current, rules)
	}
	acceptPortRuleManifest(11, signature, nil)
	if current, _ := portRuleManifestForHeartbeat(); current != signature {
		t.Fatal("matching omitted manifest cleared the cache")
	}
	acceptPortRuleManifest(12, "different", nil)
	if current, rules := portRuleManifestForHeartbeat(); current != "" || len(rules) != 0 {
		t.Fatal("missing changed manifest retained old coverage")
	}
	acceptPortRuleManifest(10, signature, &entries)
	if current, _ := portRuleManifestForHeartbeat(); current != "" {
		t.Fatal("late old revision restored coverage")
	}
	acceptPortRuleManifest(12, signature, &entries)
	if current, rules := portRuleManifestForHeartbeat(); current != signature || len(rules) != 1 {
		t.Fatal("same-revision complete resend did not restore coverage")
	}
	empty := []portRuleEntry{}
	acceptPortRuleManifest(13, signPortRuleManifest(empty), &empty)
	if _, rules := portRuleManifestForHeartbeat(); len(rules) != 0 {
		t.Fatal("explicit empty manifest did not clear coverage")
	}
}

func TestPortOccupancySignatureTracksEmptyRulePorts(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	first := portOccupancyFromListen(listen, []portRuleEntry{{RuleID: 1, Port: 11127, Protocol: "tcp"}})
	second := portOccupancyFromListen(listen, []portRuleEntry{{RuleID: 1, Port: 11127, Protocol: "tcp"}, {RuleID: 2, Port: 11128, Protocol: "udp"}})
	if len(second.Listeners) != 0 || portOccupancySignature(first) == portOccupancySignature(second) {
		t.Fatal("adding an empty rule port did not change coverage signature")
	}
	listen.add("tcp", 45000, "tcp LISTEN 0 128 0.0.0.0:45000 0.0.0.0:*")
	if portOccupancySignature(second) != portOccupancySignature(portOccupancyFromListen(listen, []portRuleEntry{{Port: 11127, Protocol: "tcp"}, {Port: 11128, Protocol: "udp"}})) {
		t.Fatal("unrelated listener changed the signature")
	}
}

func TestPortOccupancyFitsEncryptedHeartbeatEnvelope(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	listen.add("tcp", 11127, "tcp LISTEN 0 128 0.0.0.0:11127 0.0.0.0:*")
	snapshot := portOccupancyFromListen(listen, []portRuleEntry{{Port: 11127, Protocol: "tcp"}})
	request := map[string]any{"otherHeartbeatData": strings.Repeat("x", maxPortOccupancyEnvelopeBytes/2-300), "portOccupancy": &snapshot}
	fitPortOccupancyRequest(request)
	plain, _ := json.Marshal(request)
	if 2*len(plain)+256 > maxPortOccupancyEnvelopeBytes || len(snapshot.Covered) != 0 || len(snapshot.Listeners) != 0 {
		t.Fatal("oversized encrypted request retained a partially covered port")
	}
}

func TestPortBindFailureMessageNamesKnownOwner(t *testing.T) {
	snapshot := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	snapshot.parseSSListenOutput("tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:* users:((\"code\",pid=518917,fd=8))")
	if message := portBindFailureMessage(snapshot, 11127, "tcp"); !strings.Contains(message, "11127") || !strings.Contains(message, "code") {
		t.Fatalf("bind failure did not identify owner: %s", message)
	}
	snapshot.tcpPorts[11127] = []string{"tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:*"}
	if message := portBindFailureMessage(snapshot, 11127, "tcp"); strings.Contains(message, "code") || !strings.Contains(message, "11127") {
		t.Fatalf("bind failure invented owner: %s", message)
	}
	for port := 1; port <= 300; port++ {
		snapshot.add("tcp", port, "tcp LISTEN 0 128 0.0.0.0:"+strconv.Itoa(port)+" 0.0.0.0:*")
	}
	snapshot.add("tcp", 55000, "tcp LISTEN 0 128 0.0.0.0:55000 0.0.0.0:* users:((\"busy\",pid=88,fd=1))")
	if got := portBindFailureMessage(snapshot, 55000, "tcp"); !strings.Contains(got, "busy") {
		t.Fatalf("high port bind failure lost its owner: %s", got)
	}
	if got := bindFailureMessage("listen tcp :55001: bind: address already in use", 55001, "tcp", nil); got != "port 55001 occupied" {
		t.Fatalf("bind failure without a snapshot lost its port: %s", got)
	}
}

func TestManagedRuntimeRequiresServiceIdentity(t *testing.T) {
	if got := managedRuntimeFromCgroup("0::/system.slice/forwardx-runtime.service\n"); got != runtimeServiceName {
		t.Fatalf("managed service identity = %q", got)
	}
	if got := managedRuntimeFromCgroup("0::/system.slice/another-forwardx-runtime.service\n"); got != "" {
		t.Fatalf("unrelated service was accepted as managed: %q", got)
	}
	if got := managedRuntimeFromCgroup("0::/system.slice/forwardx-realm-tcp-11127.service\n"); got != "forwardx-realm" {
		t.Fatalf("managed realm service identity = %q", got)
	}
	if got := managedRuntimeFromCgroup("0::/system.slice/forwardx-socat-udp-11127.service\n"); got != "forwardx-socat" {
		t.Fatalf("managed socat service identity = %q", got)
	}
	if got := managedRuntimeFromCgroup("0::/system.slice/another-forwardx-realm-tcp-11127.service\n"); got != "" {
		t.Fatalf("unrelated realm service was accepted as managed: %q", got)
	}
	if got := managedRuntimeForListener("tcp LISTEN 0 128 0.0.0.0:11127 0.0.0.0:* users:((\"gost\",pid=999999,fd=1))", "gost"); got != "" {
		t.Fatalf("matching process name alone proved ownership: %q", got)
	}
}
