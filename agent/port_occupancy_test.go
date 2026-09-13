package main

import (
	"strconv"
	"strings"
	"testing"
)

func TestPortOccupancySnapshotPreservesListenerDetails(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	listen.parseSSListenOutput("tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:* users:((\"code\",pid=518917,fd=8))\n" +
		"tcp LISTEN 0 128 [::1]:11127 [::]:* users:((\"proxy\",pid=2,fd=4))\n" +
		"udp UNCONN 0 0 0.0.0.0:11127 0.0.0.0:* users:((\"dns\",pid=3,fd=4))")
	snapshot := portOccupancyFromListen(listen)
	if !snapshot.Complete || len(snapshot.Listeners) != 3 {
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

func TestPortOccupancySnapshotMarksTruncatedPortsUnknown(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	for port := 1; port <= 600; port++ {
		listen.add("tcp", port, "tcp LISTEN 0 128 0.0.0.0:"+strconv.Itoa(port)+" 0.0.0.0:* users:((\"service\",pid=1,fd=1))")
	}
	snapshot := portOccupancyFromListen(listen)
	if snapshot.Complete || snapshot.CoveredThrough <= 0 || snapshot.CoveredThrough >= 600 || len(snapshot.Listeners) > 256 {
		t.Fatalf("truncation lost coverage boundary: %+v", snapshot)
	}
}

func TestPortOccupancySnapshotPrioritizesRuleRangeOverLowPortNoise(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	for port := 1; port <= 300; port++ {
		listen.add("tcp", port, "tcp LISTEN 0 128 0.0.0.0:"+strconv.Itoa(port)+" 0.0.0.0:*")
	}
	listen.add("tcp", 11127, "tcp LISTEN 0 128 127.0.0.1:11127 0.0.0.0:* users:((\"code\",pid=518917,fd=8))")
	snapshot := portOccupancyFromListen(listen)
	found := false
	for _, listener := range snapshot.Listeners {
		if listener.Port == 11127 {
			found = true
		}
	}
	if !found || snapshot.Complete || snapshot.CoveredThrough >= 300 {
		t.Fatalf("common rule port or truncation coverage was lost: %+v", snapshot)
	}
}

func TestPortOccupancySnapshotDecodesProcNetAddresses(t *testing.T) {
	listen := &runtimeListenSnapshot{tcpPorts: map[int][]string{}, udpPorts: map[int][]string{}, usable: true}
	listen.add("tcp", 11127, "/proc/net/tcp:0100007F:2B77")
	listen.add("tcp", 11128, "/proc/net/tcp6:00000000000000000000000001000000:2B78")
	snapshot := portOccupancyFromListen(listen)
	if !snapshot.Complete || len(snapshot.Listeners) != 2 ||
		snapshot.Listeners[0].Address != "127.0.0.1" || snapshot.Listeners[1].Address != "::1" {
		t.Fatalf("/proc/net addresses were not preserved: %+v", snapshot)
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
