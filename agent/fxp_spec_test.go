package main

import "testing"

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

func TestFXPServerSignatureIncludesSNIRoutes(t *testing.T) {
	base := fxpSpec{
		Role:       "sni-splitter",
		ListenPort: 24000,
		Protocol:   "tcp",
		SNIRoutes:  []fxpSNIRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "203.0.113.42", TargetPort: 443}},
	}
	changed := base
	changed.SNIRoutes = []fxpSNIRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "203.0.113.42", TargetPort: 8443}}
	if fxpServerSignature(base) == fxpServerSignature(changed) {
		t.Fatal("sni route change did not affect fxp signature")
	}
}

func TestFXPRuleReadinessCandidateMatchesSNISplitter(t *testing.T) {
	spec := fxpSpec{
		Role:       "sni-splitter",
		RuleID:     42,
		ListenPort: 24000,
		Protocol:   "tcp",
		SNIRoutes:  []fxpSNIRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "203.0.113.42", TargetPort: 443}},
	}
	if !fxpRuleReadinessCandidateMatches(spec, 42, 24000, "tcp") {
		t.Fatal("sni-splitter was not accepted as a rule readiness candidate")
	}
	if fxpRuleReadinessCandidateMatches(spec, 43, 24000, "tcp") {
		t.Fatal("sni-splitter matched the wrong rule id")
	}
}
