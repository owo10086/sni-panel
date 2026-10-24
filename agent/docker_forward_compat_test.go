package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// These tests fix the contract between the commands the panel generates
// (server/agentActionCommands.ts) and the readiness the Agent derives from the
// kernel: an nftables rule is ready only when the whole forwarding path that
// ForwardX owns, and the Docker allowance it needs, are present.

const (
	labTarget = "203.0.113.10"
)

func nftTableFor(ruleID int, sourcePort int, protocols ...string) string {
	var out strings.Builder
	out.WriteString("table inet forwardx { # handle 1\n")
	out.WriteString("\tchain prerouting { # handle 1\n\t\ttype nat hook prerouting priority dstnat; policy accept;\n")
	for _, proto := range protocols {
		fmt.Fprintf(&out, "\t\tmeta l4proto %s %s dport %d counter packets 0 bytes 0 dnat ip to %s:443 comment \"fwx-rule-%d-in\" # handle 5\n", proto, proto, sourcePort, labTarget, ruleID)
	}
	out.WriteString("\t}\n\tchain postrouting { # handle 2\n\t\ttype nat hook postrouting priority srcnat; policy accept;\n")
	out.WriteString("\t\tct status dnat masquerade comment \"fwx-dnat-masquerade\" # handle 4\n\t}\n")
	out.WriteString("\tchain forward { # handle 3\n\t\ttype filter hook forward priority filter; policy accept;\n")
	for _, proto := range protocols {
		fmt.Fprintf(&out, "\t\tmeta l4proto %s ip saddr %s %s sport 443 ct original proto-dst %d ct state established,related counter packets 0 bytes 0 accept comment \"fwx-rule-%d-out\" # handle 6\n", proto, labTarget, proto, sourcePort, ruleID)
		fmt.Fprintf(&out, "\t\tmeta l4proto %s ip daddr %s %s dport 443 ct original proto-dst %d accept comment \"fwx-rule-%d\" # handle 7\n", proto, labTarget, proto, sourcePort, ruleID)
	}
	out.WriteString("\t}\n}\n")
	return out.String()
}

func dockerAllowance(ruleID int, sourcePort int, proto string, direction string) string {
	comment := fmt.Sprintf("fwx-docker-%d-%d-%s-%s", ruleID, sourcePort, proto, direction)
	if direction == "in" {
		return fmt.Sprintf("-A DOCKER-USER -d %s/32 -p %s -m %s --dport 443 -m conntrack --ctorigdstport %d -m comment --comment %s -j ACCEPT", labTarget, proto, proto, sourcePort, comment)
	}
	return fmt.Sprintf("-A DOCKER-USER -s %s/32 -p %s -m %s --sport 443 -m conntrack --ctstate RELATED,ESTABLISHED --ctorigdstport %d --ctdir REPLY -m comment --comment %s -j ACCEPT", labTarget, proto, proto, sourcePort, comment)
}

type fakeFirewall struct {
	ipForward string
	fronts    map[string]fakeFront
	tools     map[string]bool
	legacy    string
}

type fakeFront struct {
	forward    string
	dockerUser string
	forwardErr error
	userErr    error
}

func dockerFront(rules ...string) fakeFront {
	return fakeFront{
		forward:    "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n-A FORWARD -j DOCKER-FORWARD\n",
		dockerUser: "-N DOCKER-USER\n" + strings.Join(rules, "\n") + "\n",
	}
}

func (f fakeFirewall) snapshot(nft string) *kernelForwardSnapshot {
	s := newKernelForwardSnapshot()
	s.nftLoaded = true
	s.nftTable = nft
	s.env = &kernelForwardEnv{
		readFile: func(path string) ([]byte, error) {
			switch path {
			case "/proc/sys/net/ipv4/ip_forward":
				return []byte(f.ipForward), nil
			case "/proc/net/ip_tables_names":
				return []byte(f.legacy), nil
			}
			return nil, errors.New("not found")
		},
		hasCommand: func(name string) bool { return f.tools[name] },
		runIptables: func(binary string, args ...string) ([]byte, error) {
			front, ok := f.fronts[binary]
			if !ok {
				return nil, errors.New("no such front end")
			}
			switch strings.Join(args, " ") {
			case "-w 5 -S FORWARD":
				return []byte(front.forward), front.forwardErr
			case "-w 5 -S DOCKER-USER":
				return []byte(front.dockerUser), front.userErr
			}
			return nil, errors.New("unexpected iptables call")
		},
	}
	return s
}

func plainHost() fakeFirewall {
	return fakeFirewall{ipForward: "1\n", tools: map[string]bool{}, fronts: map[string]fakeFront{}}
}

func dockerHost(rules ...string) fakeFirewall {
	host := plainHost()
	host.tools = map[string]bool{"iptables-nft": true, "iptables-legacy": true}
	host.fronts = map[string]fakeFront{
		"iptables-nft":    dockerFront(rules...),
		"iptables-legacy": {forward: "-P FORWARD ACCEPT\n", dockerUser: ""},
	}
	host.legacy = "filter\n"
	return host
}

func allAllowances(ruleID int, sourcePort int, protocols ...string) []string {
	rules := []string{}
	for _, proto := range protocols {
		rules = append(rules, dockerAllowance(ruleID, sourcePort, proto, "in"), dockerAllowance(ruleID, sourcePort, proto, "out"))
	}
	return rules
}

func ready(s *kernelForwardSnapshot, protocol string) bool {
	return s.nftForwardRulePresent(42, 22022, labTarget, 443, protocol)
}

func TestNftReadinessRequiresTheWholeForwardingPath(t *testing.T) {
	complete := nftTableFor(42, 22022, "tcp", "udp")
	if !ready(plainHost().snapshot(complete), "both") {
		t.Fatal("a complete rule on a host without Docker must be ready")
	}

	t.Run("DNAT alone is not enough", func(t *testing.T) {
		dnatOnly := "table inet forwardx {\n\tchain prerouting {\n\t\tmeta l4proto tcp tcp dport 22022 dnat ip to " + labTarget + ":443 comment \"fwx-rule-42-in\"\n\t}\n}\n"
		if ready(plainHost().snapshot(dnatOnly), "tcp") {
			t.Fatal("DNAT without the forward chain and masquerade reported ready")
		}
	})

	t.Run("IP forwarding off", func(t *testing.T) {
		host := plainHost()
		host.ipForward = "0\n"
		s := host.snapshot(complete)
		if ready(s, "both") {
			t.Fatal("ip_forward=0 reported ready")
		}
		if reason := s.nftForwardRuleNotReadyReason(42, 22022, labTarget, 443, "both"); !strings.Contains(reason, "ip_forward") {
			t.Fatalf("reason %q does not name ip_forward", reason)
		}
	})

	t.Run("source address translation missing", func(t *testing.T) {
		withoutMasquerade := strings.Replace(complete, "ct status dnat masquerade comment \"fwx-dnat-masquerade\"", "", 1)
		s := plainHost().snapshot(withoutMasquerade)
		if ready(s, "both") {
			t.Fatal("missing masquerade reported ready")
		}
		if reason := s.nftForwardRuleNotReadyReason(42, 22022, labTarget, 443, "both"); !strings.Contains(reason, "masquerade") {
			t.Fatalf("reason %q does not name masquerade", reason)
		}
	})

	t.Run("per rule masquerade fallback is accepted", func(t *testing.T) {
		fallback := strings.Replace(complete, "ct status dnat masquerade comment \"fwx-dnat-masquerade\"",
			"meta l4proto tcp ip daddr "+labTarget+" tcp dport 443 masquerade comment \"fwx-rule-42-masquerade-tcp\"\n\t\tmeta l4proto udp ip daddr "+labTarget+" udp dport 443 masquerade comment \"fwx-rule-42-masquerade-udp\"", 1)
		if !ready(plainHost().snapshot(fallback), "both") {
			t.Fatal("the per-rule masquerade fallback must count")
		}
	})

	t.Run("forward accept missing for one protocol", func(t *testing.T) {
		lines := []string{}
		for _, line := range strings.Split(complete, "\n") {
			if strings.Contains(line, "udp ip daddr") || strings.Contains(line, "ip daddr "+labTarget+" udp") {
				continue
			}
			lines = append(lines, line)
		}
		if ready(plainHost().snapshot(strings.Join(lines, "\n")), "both") {
			t.Fatal("a missing UDP inbound accept reported ready")
		}
	})

	t.Run("IPv6 targets keep the earlier DNAT-only meaning", func(t *testing.T) {
		host := plainHost()
		host.ipForward = "0\n"
		dnat6 := "table inet forwardx {\n\tchain prerouting {\n\t\tmeta l4proto tcp tcp dport 22022 dnat ip6 to [2001:db8::10]:443 comment \"fwx-rule-42-in\"\n\t}\n}\n"
		if !host.snapshot(dnat6).nftForwardRulePresent(42, 22022, "2001:db8::10", 443, "tcp") {
			t.Fatal("IPv6 readiness must not gain IPv4-only requirements")
		}
	})
}

func TestNftReadinessChecksTheActiveDockerFilter(t *testing.T) {
	complete := nftTableFor(42, 22022, "tcp", "udp")

	t.Run("Docker default DROP without an allowance is not ready even though DNAT exists", func(t *testing.T) {
		s := dockerHost().snapshot(complete)
		if ready(s, "both") {
			t.Fatal("the exact production failure reported ready")
		}
		reason := s.nftForwardRuleNotReadyReason(42, 22022, labTarget, 443, "both")
		if !strings.Contains(reason, "iptables-nft") || !strings.Contains(reason, "DOCKER-USER") {
			t.Fatalf("reason %q should explain which Docker chain lacks the allowance", reason)
		}
	})

	t.Run("allowances for every protocol and direction make it ready", func(t *testing.T) {
		if !ready(dockerHost(allAllowances(42, 22022, "tcp", "udp")...).snapshot(complete), "both") {
			t.Fatal("complete allowances must be ready")
		}
	})

	t.Run("a missing return direction is detected", func(t *testing.T) {
		rules := allAllowances(42, 22022, "tcp", "udp")
		if ready(dockerHost(rules[:3]...).snapshot(complete), "both") {
			t.Fatal("missing UDP return allowance reported ready")
		}
	})

	t.Run("allowances of a neighbour sharing the target do not count", func(t *testing.T) {
		if ready(dockerHost(allAllowances(43, 22023, "tcp", "udp")...).snapshot(complete), "both") {
			t.Fatal("another rule's allowance was accepted")
		}
		wrongPort := strings.ReplaceAll(strings.Join(allAllowances(42, 22022, "tcp", "udp"), "\n"), "--ctorigdstport 22022", "--ctorigdstport 22023")
		if ready(dockerHost(strings.Split(wrongPort, "\n")...).snapshot(complete), "both") {
			t.Fatal("an allowance for another original port was accepted")
		}
	})

	t.Run("an allowance for a different target is not accepted", func(t *testing.T) {
		moved := strings.ReplaceAll(strings.Join(allAllowances(42, 22022, "tcp", "udp"), "\n"), labTarget, "203.0.113.11")
		if ready(dockerHost(strings.Split(moved, "\n")...).snapshot(complete), "both") {
			t.Fatal("stale allowance for the previous target was accepted")
		}
	})

	t.Run("an administrator rule with the same comment but another verdict is not an allowance", func(t *testing.T) {
		forged := strings.ReplaceAll(strings.Join(allAllowances(42, 22022, "tcp"), "\n"), "-j ACCEPT", "-j DROP")
		if ready(dockerHost(strings.Split(forged, "\n")...).snapshot(nftTableFor(42, 22022, "tcp")), "tcp") {
			t.Fatal("a DROP rule was accepted as an allowance")
		}
	})

	t.Run("the legacy view does not mislead the check", func(t *testing.T) {
		host := dockerHost()
		legacy := host.fronts["iptables-legacy"]
		legacy.forward = "-P FORWARD ACCEPT\n"
		host.fronts["iptables-legacy"] = legacy
		if ready(host.snapshot(complete), "both") {
			t.Fatal("legacy ACCEPT hid the nft DROP")
		}
	})

	t.Run("a default ACCEPT filter needs no allowance", func(t *testing.T) {
		host := dockerHost()
		front := host.fronts["iptables-nft"]
		front.forward = "-P FORWARD ACCEPT\n-A FORWARD -j DOCKER-USER\n"
		host.fronts["iptables-nft"] = front
		if !ready(host.snapshot(complete), "both") {
			t.Fatal("no default DROP, nothing to allow")
		}
	})

	t.Run("a default DROP that does not use DOCKER-USER is outside the supported structure", func(t *testing.T) {
		host := dockerHost()
		front := host.fronts["iptables-nft"]
		front.forward = "-P FORWARD DROP\n-A FORWARD -j ufw-before-forward\n"
		host.fronts["iptables-nft"] = front
		if !ready(host.snapshot(complete), "both") {
			t.Fatal("custom firewalls are not judged")
		}
	})

	t.Run("an unreadable DOCKER-USER chain is reported, not assumed fine", func(t *testing.T) {
		host := dockerHost()
		front := host.fronts["iptables-nft"]
		front.userErr = errors.New("Permission denied")
		host.fronts["iptables-nft"] = front
		s := host.snapshot(complete)
		if ready(s, "both") {
			t.Fatal("an unreadable Docker chain reported ready")
		}
		if reason := s.nftForwardRuleNotReadyReason(42, 22022, labTarget, 443, "both"); !strings.Contains(reason, "cannot read") {
			t.Fatalf("reason %q should say the chain cannot be read", reason)
		}
	})

	t.Run("legacy tables are consulted only when loaded", func(t *testing.T) {
		host := dockerHost(allAllowances(42, 22022, "tcp", "udp")...)
		legacy := host.fronts["iptables-legacy"]
		legacy.forward = "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER\n"
		host.fronts["iptables-legacy"] = legacy
		host.legacy = ""
		if !ready(host.snapshot(complete), "both") {
			t.Fatal("unloaded legacy tables must not be read")
		}
		host.legacy = "filter\nnat\n"
		if ready(host.snapshot(complete), "both") {
			t.Fatal("a loaded legacy table with its own default DROP needs its own allowance")
		}
	})

	t.Run("a lone iptables binary is used when no variants exist", func(t *testing.T) {
		host := plainHost()
		host.tools = map[string]bool{"iptables": true}
		host.fronts = map[string]fakeFront{"iptables": dockerFront()}
		if ready(host.snapshot(complete), "both") {
			t.Fatal("the single front end's Docker DROP was ignored")
		}
	})
}
