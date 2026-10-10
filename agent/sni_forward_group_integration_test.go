package main

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"
)

// The panel integration exports its actual heartbeat. This optional network
// check runs the Agent's existing desired-state and probe pipeline unchanged.
func TestSniForwardGroupDestinationProbes(t *testing.T) {
	input := os.Getenv("FORWARDX_SNI_PROBE_INPUT")
	if input == "" {
		t.Skip("requires exported heartbeat and isolated destination services")
	}
	data, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	var rules []runningRule
	if err := json.Unmarshal(data, &rules); err != nil {
		t.Fatal(err)
	}
	rememberDesiredRunningRules(rules)
	tasks := []tcpingTask{}
	for _, rule := range rules {
		task, ok := buildRuleLatencyProbeTask(localRuleState{RuleID: rule.RuleID, Port: strconv.Itoa(rule.SourcePort)})
		if !ok || task.GroupHealth == nil {
			t.Fatalf("no managed destination check for rule %d", rule.RuleID)
		}
		tasks = append(tasks, task)
	}
	if len(tasks) == 0 {
		t.Fatal("heartbeat has no destination checks")
	}
	output := os.Getenv("FORWARDX_SNI_PROBE_OUTPUT")
	collect := func(stage string) {
		results, _, _, _ := runTCPingTasks(tasks)
		data, err := json.Marshal(results)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(output+"-"+stage+".json", data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	wait := func(stage string) {
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(output + "-" + stage + ".trigger"); err == nil {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("network scenario did not reach %s", stage)
	}
	collect("healthy")
	wait("fail")
	collect("pending")
	time.Sleep(11 * time.Second)
	collect("failed")
	wait("recover")
	collect("recover-pending")
	time.Sleep(11 * time.Second)
	collect("recovered")
}

// Exercise the unchanged Agent action boundary against a real splitter. An
// obsolete version makes the socket reject the removal while it keeps serving.
func TestSniForwardGroupFailedRevocation(t *testing.T) {
	input := os.Getenv("FORWARDX_SNI_REVOCATION_ACTION")
	if input == "" {
		t.Skip("requires exported removal action and isolated running splitter")
	}
	read := func(path string, target any) {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, target); err != nil {
			t.Fatal(err)
		}
	}
	var initial fxpSpec
	read(os.Getenv("FORWARDX_SNI_REVOCATION_INITIAL"), &initial)
	var removal action
	read(input, &removal)
	cfg := Config{}
	if !startFXP(cfg, initial, nil, &actionMessage{}) {
		t.Fatal("could not adopt the actual running splitter")
	}
	writeState(action{RuleID: initial.RuleID, SourcePort: initial.ListenPort, ForwardType: "forwardx", Protocol: "tcp", Fxp: &initial})
	if os.Getenv("FORWARDX_SNI_REVOCATION_ADOPT_ONLY") == "1" {
		return
	}
	removal.Fxp.ListenHost = initial.ListenHost
	expectFailure := os.Getenv("FORWARDX_SNI_REVOCATION_FAIL") == "1"
	if expectFailure {
		removal.Fxp.SNIRouteVersion = initial.SNIRouteVersion
	}
	if ok := handleAction(cfg, removal); ok == expectFailure {
		t.Fatalf("removal action ok=%v, expected failure=%v", ok, expectFailure)
	}
}

// Replay actual member-add and member-disable actions inside the isolated
// network fixture. The fixture verifies both ports with real TLS connections.
func TestSniForwardGroupMemberActions(t *testing.T) {
	input := os.Getenv("FORWARDX_SNI_MEMBER_ACTIONS")
	if input == "" {
		t.Skip("requires exported member actions and isolated destination services")
	}
	data, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	var actions []action
	if err := json.Unmarshal(data, &actions); err != nil {
		t.Fatal(err)
	}
	if len(actions) == 0 {
		t.Fatal("heartbeat has no member actions")
	}
	for _, item := range actions {
		if !handleAction(Config{}, item) {
			t.Fatalf("member action failed: %s rule %d port %d", item.Op, item.RuleID, item.SourcePort)
		}
	}
}
