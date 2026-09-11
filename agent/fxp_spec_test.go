package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestNormalizeFXPSpecExitStrategies(t *testing.T) {
	for _, strategy := range []string{"fallback", "random", "ip_hash", "round_robin"} {
		spec := normalizeFXPSpec(fxpSpec{ExitStrategy: strategy})
		if spec.ExitStrategy != strategy {
			t.Fatalf("strategy %q normalized to %q", strategy, spec.ExitStrategy)
		}
	}
	if spec := normalizeFXPSpec(fxpSpec{ExitStrategy: "none"}); spec.ExitStrategy != "round_robin" {
		t.Fatalf("unsupported strategy normalized to %q", spec.ExitStrategy)
	}
}

func TestNormalizeFXPSpecSNISplitterRoutes(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:       " SNI-SPLITTER ",
		ListenPort: 24000,
		Protocol:   "udp",
		Key:        "legacy-key",
		SNIRoutes: []fxpSNIRoute{
			{SNI: " WWW.EXAMPLE.COM. ", RuleID: 41, TargetIP: " 203.0.113.41 ", TargetPort: 443},
			{SNI: " API.EXAMPLE.COM. ", RuleID: 42, TargetIP: " 203.0.113.42 ", TargetPort: 443},
			{SNI: " api.example.com ", RuleID: 43, TargetIP: " 203.0.113.43 ", TargetPort: 8443},
		},
	})
	if spec.Role != "sni-splitter" || spec.Protocol != "tcp" || spec.Key != "" {
		t.Fatalf("sni-splitter base fields were not normalized: %+v", spec)
	}
	if len(spec.SNIRoutes) != 2 {
		t.Fatalf("sni routes were not deduplicated: %+v", spec.SNIRoutes)
	}
	if route := spec.SNIRoutes[0]; route.SNI != "api.example.com" || route.RuleID != 43 || route.TargetIP != "203.0.113.43" || route.TargetPort != 8443 {
		t.Fatalf("api route was not normalized with last write winning: %+v", route)
	}
	if route := spec.SNIRoutes[1]; route.SNI != "www.example.com" || route.RuleID != 41 || route.TargetIP != "203.0.113.41" {
		t.Fatalf("www route was not normalized: %+v", route)
	}
}

func TestFXPServerSignatureIgnoresSNIRouteTable(t *testing.T) {
	base := fxpSpec{
		Role:            "sni-splitter",
		RuleID:          42,
		ListenPort:      24000,
		Protocol:        "tcp",
		SNIRouteVersion: 7,
		SNIRoutes:       []fxpSNIRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "203.0.113.42", TargetPort: 443}},
	}
	changed := base
	changed.RuleID = 43
	changed.SNIRouteVersion = 8
	changed.SNIRoutes = []fxpSNIRoute{{SNI: "api.example.com", RuleID: 43, TargetIP: "203.0.113.42", TargetPort: 8443}}
	if fxpServerID(base) != fxpServerID(changed) {
		t.Fatal("sni route table representative rule changed fxp process identity")
	}
	if fxpConfigPath(base) != fxpConfigPath(changed) {
		t.Fatal("sni route table representative rule changed fxp config path")
	}
	if fxpServerSignature(base) != fxpServerSignature(changed) {
		t.Fatal("sni route table change affected fxp process signature")
	}
	if fxpSNIRouteTableSignature(base) == fxpSNIRouteTableSignature(changed) {
		t.Fatal("sni route table change did not affect route table signature")
	}
}

func TestValidateFXPSNIRouteTableRequiresVersion(t *testing.T) {
	spec := normalizeFXPSpec(fxpSpec{
		Role:       "sni-splitter",
		RuleID:     42,
		ListenPort: 24000,
		Protocol:   "tcp",
		SNIRoutes:  []fxpSNIRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "203.0.113.42", TargetPort: 443}},
	})
	if err := validateFXPSNIRouteTable(spec); err == nil {
		t.Fatal("sni route table without version was accepted")
	}
	spec.SNIRouteVersion = 1
	if err := validateFXPSNIRouteTable(spec); err != nil {
		t.Fatalf("sni route table with explicit version was rejected: %v", err)
	}
}

func TestFXPSNISplitterReadyForRouteTableUpdateAllowsRepresentativeChange(t *testing.T) {
	executablePath := filepath.Join(t.TempDir(), "forwardx-fxp")
	if err := os.WriteFile(executablePath, []byte("runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	executableInfo, err := os.Stat(executablePath)
	if err != nil {
		t.Fatal(err)
	}
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return executablePath, nil },
		func(string) []int { return nil },
		func(int, string) bool { return true },
	)
	cfg := Config{PanelURL: "https://panel.example.test", Token: "agent-token"}
	previousPanelURL, _ := runtimePanelURL.Load().(string)
	previousToken, _ := runtimeAgentToken.Load().(string)
	setRuntimePanelURL(cfg.PanelURL)
	runtimeAgentToken.Store(cfg.Token)
	t.Cleanup(func() {
		runtimePanelURL.Store(previousPanelURL)
		runtimeAgentToken.Store(previousToken)
	})
	base := normalizeFXPSpec(fxpSpec{
		Role:              "sni-splitter",
		RuleID:            102,
		ListenPort:        24000,
		Protocol:          "tcp",
		SNIRouteVersion:   7,
		ControlSocketPath: "/tmp/forwardx-sni-test.sock",
		PanelURL:          cfg.PanelURL,
		Token:             cfg.Token,
		SNIRoutes: []fxpSNIRoute{
			{SNI: "api.example.com", RuleID: 102, TargetIP: "203.0.113.20", TargetPort: 443},
			{SNI: "web.example.com", RuleID: 112, TargetIP: "203.0.113.21", TargetPort: 8443},
		},
	})
	changed := base
	changed.RuleID = 112
	changed.SNIRouteVersion = 8
	changed.SNIRoutes = []fxpSNIRoute{{SNI: "web.example.com", RuleID: 112, TargetIP: "203.0.113.21", TargetPort: 8443}}
	withTestFXPServers(t, map[string]*fxpProcess{
		fxpServerID(base): {
			signature:             fxpServerSignature(base),
			cmd:                   &exec.Cmd{Process: &os.Process{Pid: os.Getpid()}},
			spec:                  base,
			runtimeExecutable:     executableInfo,
			panelCredentialDigest: fxpPanelCredentialDigest(cfg.PanelURL, cfg.Token),
		},
	})
	withTestRuntimeListenReadiness(t, base.ListenPort)

	if fxpMatchesRunning(&changed) {
		t.Fatal("stale sni route table was treated as fully running")
	}
	if !fxpSNISplitterReadyForRouteTableUpdate(cfg, &changed) {
		t.Fatal("sni splitter with changed representative rule was not accepted for route table update")
	}
	action := action{
		RuleID:      changed.RuleID,
		Op:          "apply",
		ForwardType: "forwardx",
		SourcePort:  changed.ListenPort,
		Protocol:    "tcp",
		Fxp:         &changed,
	}
	if !actionCanReuseSNISplitterRuntimeForRouteTableUpdate(cfg, action, base.RuleID, "forwardx", 0, "tcp", true) {
		t.Fatal("sni splitter local marker with previous representative rule was not accepted for route table update")
	}
}

func TestFXPMatchesRunningRequiresCurrentSNIRouteTable(t *testing.T) {
	executablePath := filepath.Join(t.TempDir(), "forwardx-fxp")
	if err := os.WriteFile(executablePath, []byte("runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	executableInfo, err := os.Stat(executablePath)
	if err != nil {
		t.Fatal(err)
	}
	withFXPRuntimeExecutableHooks(
		t,
		func() (string, error) { return executablePath, nil },
		func(string) []int { return nil },
		func(int, string) bool { return true },
	)
	base := normalizeFXPSpec(fxpSpec{
		Role:              "sni-splitter",
		RuleID:            42,
		ListenPort:        24000,
		Protocol:          "tcp",
		SNIRouteVersion:   7,
		ControlSocketPath: "/tmp/forwardx-sni-test.sock",
		SNIRoutes: []fxpSNIRoute{{
			SNI:        "api.example.com",
			RuleID:     42,
			TargetIP:   "203.0.113.42",
			TargetPort: 443,
		}},
	})
	changed := base
	changed.SNIRouteVersion = 8
	changed.SNIRoutes = []fxpSNIRoute{{
		SNI:        "api.example.com",
		RuleID:     42,
		TargetIP:   "203.0.113.42",
		TargetPort: 8443,
	}}
	withTestFXPServers(t, map[string]*fxpProcess{
		fxpServerID(base): {
			signature:         fxpServerSignature(base),
			cmd:               &exec.Cmd{Process: &os.Process{Pid: os.Getpid()}},
			spec:              base,
			runtimeExecutable: executableInfo,
		},
	})
	withTestRuntimeListenReadiness(t, base.ListenPort)

	if !fxpMatchesRunning(&base) {
		t.Fatal("matching sni route table was not accepted")
	}
	if fxpMatchesRunning(&changed) {
		t.Fatal("stale sni route table was treated as running")
	}
}

func TestLocalRuntimeStateReportsSNISplitterRoutes(t *testing.T) {
	usePersistentRuntimeTestDirs(t)
	spec := normalizeFXPSpec(fxpSpec{
		Role:             "sni-splitter",
		TunnelID:         12,
		RuleID:           101,
		ListenPort:       24000,
		Protocol:         "tcp",
		SNIRouteVersion:  3,
		TransportVersion: forwardXWireGuardVersion,
		SNIRoutes: []fxpSNIRoute{
			{SNI: "api.example.com", RuleID: 101, TargetIP: "203.0.113.10", TargetPort: 443},
			{SNI: "web.example.com", RuleID: 202, TargetIP: "203.0.113.11", TargetPort: 8443},
		},
	})
	withTestFXPServers(t, map[string]*fxpProcess{fxpServerID(spec): {spec: spec}})
	withTestRuntimeListenReadiness(t, spec.ListenPort)

	payload := readLocalRuntimeStatePayload()
	seen := map[int]localRuntimeRuleState{}
	for _, rule := range payload.Rules {
		if rule.Port == spec.ListenPort {
			seen[rule.RuleID] = rule
		}
	}
	for _, ruleID := range []int{101, 202} {
		rule, ok := seen[ruleID]
		if !ok {
			t.Fatalf("sni splitter route %d was not reported in local runtime state: %+v", ruleID, payload.Rules)
		}
		if rule.ForwardType != "forwardx" || rule.Protocol != "tcp" || rule.TransportVersion != forwardXWireGuardVersion || !rule.Ready {
			t.Fatalf("sni splitter route %d reported unexpected local state: %+v", ruleID, rule)
		}
		if rule.SNI == "" || rule.TargetIP == "" || rule.TargetPort <= 0 || rule.SNIRouteVersion != spec.SNIRouteVersion {
			t.Fatalf("sni splitter route %d missed route table fields: %+v", ruleID, rule)
		}
	}
}

func withTestRuntimeListenReadiness(t *testing.T, port int) {
	t.Helper()
	localRuntimeReadinessCacheMu.Lock()
	previousCache := localRuntimeReadinessCacheResult
	previousCachedAt := localRuntimeReadinessCachedAt
	previousInvalid := localRuntimeReadinessCacheInvalid
	localRuntimeReadinessCacheResult = &localRuntimeReadiness{listenSnapshot: &runtimeListenSnapshot{
		tcpPorts: map[int][]string{
			port: {`tcp LISTEN 0 4096 *:24000 *:* users:(("forwardx-fxp",pid=75,fd=3))`},
		},
		udpPorts: map[int][]string{},
		usable:   true,
	}}
	localRuntimeReadinessCachedAt = time.Now()
	localRuntimeReadinessCacheInvalid = false
	localRuntimeReadinessCacheMu.Unlock()
	t.Cleanup(func() {
		localRuntimeReadinessCacheMu.Lock()
		localRuntimeReadinessCacheResult = previousCache
		localRuntimeReadinessCachedAt = previousCachedAt
		localRuntimeReadinessCacheInvalid = previousInvalid
		localRuntimeReadinessCacheMu.Unlock()
	})
}

func TestFXPRuleReadinessCandidateMatchesSNISplitter(t *testing.T) {
	spec := fxpSpec{
		Role:       "sni-splitter",
		RuleID:     42,
		ListenPort: 24000,
		Protocol:   "tcp",
		SNIRoutes: []fxpSNIRoute{
			{SNI: "api.example.com", RuleID: 42, TargetIP: "203.0.113.42", TargetPort: 443},
			{SNI: "web.example.com", RuleID: 202, TargetIP: "203.0.113.43", TargetPort: 8443},
		},
	}
	if !fxpRuleReadinessCandidateMatches(spec, 42, 24000, "tcp") {
		t.Fatal("sni-splitter was not accepted as a rule readiness candidate")
	}
	if !fxpRuleReadinessCandidateMatches(spec, 202, 24000, "tcp") {
		t.Fatal("sni-splitter route was not accepted as a rule readiness candidate")
	}
	if fxpRuleReadinessCandidateMatches(spec, 43, 24000, "tcp") {
		t.Fatal("sni-splitter matched the wrong rule id")
	}
}
