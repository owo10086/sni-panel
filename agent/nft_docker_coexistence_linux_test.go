//go:build linux

package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// Optional operations for scripts/verify-nft-docker-coexistence.mjs. The script
// exports the panel's real heartbeat actions, replays them through the Agent's
// unchanged desired-state path inside a disposable privileged container and
// reads back the status the Agent would report. Each operation is a separate
// process, so a new invocation is also a faithful Agent restart.
//
//	FORWARDX_NFT_DOCKER_OP=sync   apply a desired state and collect action status
//	FORWARDX_NFT_DOCKER_OP=apply  run every action unconditionally, as a manual or heartbeat retry does
//	FORWARDX_NFT_DOCKER_OP=state  collect the local runtime state sent in heartbeats
//	FORWARDX_NFT_DOCKER_OP=dns    run the Agent's DNS watch against the container's own /etc/hosts
//	FORWARDX_NFT_DOCKER_OP=reconcile  let the Agent drop local rules the panel no longer lists
type nftDockerInput struct {
	State        *desiredState  `json:"state"`
	RunningRules []runningRule  `json:"runningRules"`
	Watch        []dnsWatchItem `json:"dnsWatch"`
	HostsBefore  string         `json:"hostsBefore"`
	HostsAfter   string         `json:"hostsAfter"`
}

type nftDockerOutput struct {
	Reports    []actionStatusPayload    `json:"reports"`
	LocalState localRuntimeStatePayload `json:"localState"`
	Signature  string                   `json:"localStateSignature"`
	Applied    []bool                   `json:"applied,omitempty"`
	DNSChanged []dnsChangeReport        `json:"dnsChanged,omitempty"`
}

func TestNftDockerAgentOperation(t *testing.T) {
	op := os.Getenv("FORWARDX_NFT_DOCKER_OP")
	if op == "" {
		t.Skip("requires the isolated Docker coexistence lab")
	}
	if _, err := os.Stat("/.dockerenv"); err != nil || os.Geteuid() != 0 {
		t.Fatal("refusing to alter firewall state outside a disposable container")
	}
	path := os.Getenv("FORWARDX_NFT_DOCKER_IO")
	if path == "" {
		t.Fatal("FORWARDX_NFT_DOCKER_IO is required")
	}
	var input nftDockerInput
	if raw, err := os.ReadFile(path); err == nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, &input); err != nil {
			t.Fatal(err)
		}
	}
	var applied []bool
	var dnsChanged []dnsChangeReport
	switch op {
	case "sync":
		if input.State == nil {
			t.Fatal("sync requires a desired state")
		}
		go actionWorker()
		for _, done := range syncDesiredState(Config{}, input.State) {
			select {
			case <-done:
			case <-time.After(90 * time.Second):
				t.Fatal("desired action did not finish")
			}
		}
	case "apply":
		if input.State == nil {
			t.Fatal("apply requires actions")
		}
		for _, a := range input.State.Actions {
			if a.IssuedAt <= 0 {
				a.IssuedAt = input.State.IssuedAt
			}
			applied = append(applied, handleAction(Config{}, a))
		}
	case "dns":
		// The scan, confirmation count and quiet period are the Agent's own; only the
		// clock is advanced explicitly and the resolver is the container's /etc/hosts.
		start := time.Now()
		if err := os.WriteFile("/etc/hosts", []byte(input.HostsBefore), 0644); err != nil {
			t.Fatal(err)
		}
		updateDNSWatchWithLookupAt(input.Watch, lookupDNSWatchIPs, start)
		if err := os.WriteFile("/etc/hosts", []byte(input.HostsAfter), 0644); err != nil {
			t.Fatal(err)
		}
		// Go's resolver re-reads the hosts file at most every five seconds.
		time.Sleep(5500 * time.Millisecond)
		for _, elapsed := range []time.Duration{time.Second, 6 * time.Second, 12 * time.Second} {
			updateDNSWatchWithLookupAt(input.Watch, lookupDNSWatchIPs, start.Add(elapsed))
		}
		dnsChanged = takePendingDNSChanges()
	case "reconcile":
		syncRunningRuleState(input.RunningRules, nil)
	case "state":
	default:
		t.Fatalf("unknown operation %q", op)
	}
	invalidateLocalRuntimeReadinessCache()
	forceSendLocalRuntimeState = true
	signature, local := localRuntimeStateForHeartbeat()
	output := nftDockerOutput{Signature: signature, Applied: applied, DNSChanged: dnsChanged}
	for _, report := range takeActionStatusReports(100000) {
		output.Reports = append(output.Reports, report.payload)
	}
	if local != nil {
		output.LocalState = *local
	}
	raw, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".out", raw, 0600); err != nil {
		t.Fatal(err)
	}
}
