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
type nftDockerInput struct {
	State *desiredState `json:"state"`
}

type nftDockerOutput struct {
	Reports    []actionStatusPayload    `json:"reports"`
	LocalState localRuntimeStatePayload `json:"localState"`
	Signature  string                   `json:"localStateSignature"`
	Applied    []bool                   `json:"applied,omitempty"`
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
	case "state":
	default:
		t.Fatalf("unknown operation %q", op)
	}
	invalidateLocalRuntimeReadinessCache()
	forceSendLocalRuntimeState = true
	signature, local := localRuntimeStateForHeartbeat()
	output := nftDockerOutput{Signature: signature, Applied: applied}
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
