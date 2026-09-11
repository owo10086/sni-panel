package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
)

func readConfig(path string) (config, error) {
	var cfg config
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	return normalizeConfig(cfg), nil
}

func normalizeConfig(cfg config) config {
	cfg.Role = strings.ToLower(strings.TrimSpace(cfg.Role))
	cfg.Protocol = normalizeProtocol(cfg.Protocol)
	cfg.TargetIP = strings.TrimSpace(cfg.TargetIP)
	cfg.ExitHost = strings.TrimSpace(cfg.ExitHost)
	cfg.ExitStrategy = normalizeExitStrategy(cfg.ExitStrategy)
	cfg.RelayExitHost = strings.TrimSpace(cfg.RelayExitHost)
	cfg.ListenHost = strings.TrimSpace(cfg.ListenHost)
	cfg.ControlSocketPath = strings.TrimSpace(cfg.ControlSocketPath)
	cfg.ProxyProtocolVersion = normalizeProxyProtocolVersion(cfg.ProxyProtocolVersion)
	if cfg.UDPListenPort <= 0 {
		cfg.UDPListenPort = cfg.ListenPort
	}
	if cfg.UDPExitPort <= 0 {
		cfg.UDPExitPort = cfg.ExitPort
	}
	if cfg.UDPRelayExitPort <= 0 {
		cfg.UDPRelayExitPort = cfg.RelayExitPort
	}
	for i := range cfg.Exits {
		cfg.Exits[i].Host = strings.TrimSpace(cfg.Exits[i].Host)
		if cfg.Exits[i].UDPPort <= 0 {
			cfg.Exits[i].UDPPort = cfg.Exits[i].Port
		}
		if cfg.Exits[i].Key == "" {
			cfg.Exits[i].Key = cfg.Key
		}
	}
	udpTargets := make([]udpTarget, 0, len(cfg.UDPTargets))
	seenUDPTargets := make(map[int]bool)
	for _, target := range cfg.UDPTargets {
		target.RuleID = int(target.RuleID)
		target.TargetIP = strings.TrimSpace(target.TargetIP)
		if target.RuleID <= 0 || target.TargetIP == "" || target.TargetPort <= 0 || target.TargetPort > 65535 || seenUDPTargets[target.RuleID] {
			continue
		}
		seenUDPTargets[target.RuleID] = true
		udpTargets = append(udpTargets, target)
	}
	sort.Slice(udpTargets, func(i, j int) bool { return udpTargets[i].RuleID < udpTargets[j].RuleID })
	cfg.UDPTargets = udpTargets
	cfg.SNIRoutes = normalizeSNIRoutes(cfg.SNIRoutes)
	cfg.SourceAllowIPs = normalizeSourceAllowIPs(cfg.SourceAllowIPs)
	for i := range cfg.Entries {
		cfg.Entries[i] = normalizeConfig(cfg.Entries[i])
	}
	return cfg
}

func normalizeExitStrategy(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "fallback", "random", "ip_hash":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "round_robin"
	}
}

func validateConfig(cfg config) error {
	if cfg.Role == "entry-group" {
		return validateEntryGroupConfig(cfg)
	}
	if cfg.Role == "sni-splitter" {
		return validateSNISplitterConfig(cfg)
	}
	if cfg.Key == "" {
		return errors.New("empty key")
	}
	if cfg.ListenPort <= 0 || cfg.ListenPort > 65535 {
		return fmt.Errorf("bad listen port %d", cfg.ListenPort)
	}
	if cfg.UDPListenPort < 0 || cfg.UDPListenPort > 65535 {
		return fmt.Errorf("bad udp listen port %d", cfg.UDPListenPort)
	}
	if cfg.ListenHost != "" && cfg.ListenHost != "127.0.0.1" && cfg.ListenHost != "::1" {
		return fmt.Errorf("unsupported listen host %q", cfg.ListenHost)
	}
	if cfg.Role == "entry" {
		if cfg.ExitHost == "" || cfg.ExitPort <= 0 || cfg.ExitPort > 65535 {
			return errors.New("entry requires exit host and port")
		}
		for _, exit := range cfg.Exits {
			if exit.Host == "" || exit.Port <= 0 || exit.Port > 65535 || exit.UDPPort <= 0 || exit.UDPPort > 65535 {
				return errors.New("entry exits require host and port")
			}
		}
		if cfg.UDPExitPort < 0 || cfg.UDPExitPort > 65535 {
			return errors.New("entry requires a valid udp exit port")
		}
		if cfg.TargetIP == "" || cfg.TargetPort <= 0 || cfg.TargetPort > 65535 {
			return errors.New("entry requires target host and port")
		}
	}
	if (cfg.ProxyProtocolReceive || cfg.ProxyProtocolSend || cfg.ProxyProtocolExitReceive || cfg.ProxyProtocolExitSend) && cfg.Protocol == "udp" {
		return errors.New("proxy protocol requires tcp protocol")
	}
	if cfg.Role == "relay" {
		if cfg.RelayExitHost == "" || cfg.RelayExitPort <= 0 || cfg.RelayExitPort > 65535 || cfg.RelayKey == "" {
			return errors.New("relay requires relay exit host, port, and key")
		}
		if cfg.UDPRelayExitPort < 0 || cfg.UDPRelayExitPort > 65535 {
			return errors.New("relay requires a valid udp relay exit port")
		}
	}
	return nil
}

func normalizeSNIRoutes(routes []sniRoute) []sniRoute {
	normalized := make([]sniRoute, 0, len(routes))
	seen := map[string]int{}
	for _, route := range routes {
		route.SNI = normalizeSNIName(route.SNI)
		route.TargetIP = strings.TrimSpace(route.TargetIP)
		route.AccessScope = strings.TrimSpace(route.AccessScope)
		if index, exists := seen[route.SNI]; exists {
			normalized[index] = route
			continue
		}
		seen[route.SNI] = len(normalized)
		normalized = append(normalized, route)
	}
	sort.Slice(normalized, func(i, j int) bool {
		if normalized[i].SNI != normalized[j].SNI {
			return normalized[i].SNI < normalized[j].SNI
		}
		return normalized[i].RuleID < normalized[j].RuleID
	})
	return normalized
}

func normalizeSNIName(value string) string {
	return strings.TrimRight(strings.ToLower(strings.TrimSpace(value)), ".")
}

func normalizeSourceAllowIPs(values []string) []string {
	seen := map[string]bool{}
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		address := strings.TrimSpace(value)
		address = strings.TrimPrefix(strings.TrimSuffix(address, "]"), "[")
		parsed := net.ParseIP(address)
		if parsed == nil {
			continue
		}
		address = strings.ToLower(parsed.String())
		if seen[address] {
			continue
		}
		seen[address] = true
		normalized = append(normalized, address)
	}
	sort.Strings(normalized)
	return normalized
}

func validateSNISplitterConfig(cfg config) error {
	if cfg.ListenPort <= 0 || cfg.ListenPort > 65535 {
		return fmt.Errorf("bad listen port %d", cfg.ListenPort)
	}
	if cfg.ListenHost != "" && cfg.ListenHost != "127.0.0.1" && cfg.ListenHost != "::1" {
		return fmt.Errorf("unsupported listen host %q", cfg.ListenHost)
	}
	if cfg.Protocol != "tcp" {
		return errors.New("sni-splitter requires tcp protocol")
	}
	if cfg.SNIRouteVersion <= 0 {
		return errors.New("sni-splitter route table version required")
	}
	if len(cfg.SNIRoutes) == 0 {
		return errors.New("sni-splitter requires at least one route")
	}
	for i, route := range cfg.SNIRoutes {
		if route.RuleID <= 0 {
			return fmt.Errorf("sni-splitter route %d requires rule id", i)
		}
		if !validSNIName(route.SNI) {
			return fmt.Errorf("sni-splitter route %d requires valid sni", i)
		}
		if route.TargetIP == "" || route.TargetPort <= 0 || route.TargetPort > 65535 {
			return fmt.Errorf("sni-splitter route %d requires target host and port", i)
		}
	}
	return nil
}

func validSNIName(value string) bool {
	value = normalizeSNIName(value)
	if value == "" || len(value) > 253 || strings.Contains(value, "*") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		for i, r := range label {
			alpha := r >= 'a' && r <= 'z'
			digit := r >= '0' && r <= '9'
			hyphen := r == '-'
			if !alpha && !digit && !hyphen {
				return false
			}
			if (i == 0 || i == len(label)-1) && hyphen {
				return false
			}
		}
	}
	return true
}

type entryListenLane struct {
	network string
	host    string
	port    int
	index   int
}

type entryListenLaneRegistry struct {
	first    map[string]entryListenLane
	wildcard map[string]entryListenLane
	exact    map[string]entryListenLane
}

func newEntryListenLaneRegistry(size int) *entryListenLaneRegistry {
	return &entryListenLaneRegistry{
		first:    make(map[string]entryListenLane, size),
		wildcard: make(map[string]entryListenLane, size),
		exact:    make(map[string]entryListenLane, size),
	}
}

func validateEntryGroupConfig(cfg config) error {
	if len(cfg.Entries) == 0 {
		return errors.New("entry-group requires at least one entry")
	}
	lanes := newEntryListenLaneRegistry(len(cfg.Entries) * 2)
	for i, entry := range cfg.Entries {
		if entry.Role != "entry" {
			return fmt.Errorf("entry-group entry %d requires role entry", i)
		}
		if entry.TunnelID != cfg.TunnelID {
			return fmt.Errorf("entry-group entry %d tunnel %d does not match group tunnel %d", i, entry.TunnelID, cfg.TunnelID)
		}
		if err := validateConfig(entry); err != nil {
			return fmt.Errorf("entry-group entry %d: %w", i, err)
		}
		if protocolHas(entry, "tcp") {
			if err := lanes.add(entryListenLane{network: "tcp", host: entry.ListenHost, port: entry.ListenPort, index: i}); err != nil {
				return err
			}
		}
		if protocolHas(entry, "udp") {
			if err := lanes.add(entryListenLane{network: "udp", host: entry.ListenHost, port: udpListenPort(entry), index: i}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (registry *entryListenLaneRegistry) add(lane entryListenLane) error {
	lane.host = strings.TrimSpace(lane.host)
	key := lane.network + ":" + strconv.Itoa(lane.port)
	var existing entryListenLane
	conflict := false
	if lane.host == "" {
		existing, conflict = registry.first[key]
	} else {
		existing, conflict = registry.wildcard[key]
		if !conflict {
			existing, conflict = registry.exact[key+"\x00"+lane.host]
		}
	}
	if conflict {
		return fmt.Errorf(
			"entry-group entries %d and %d conflict on %s listen %s",
			existing.index,
			lane.index,
			lane.network,
			listenAddress(lane.host, lane.port),
		)
	}
	if _, exists := registry.first[key]; !exists {
		registry.first[key] = lane
	}
	if lane.host == "" {
		registry.wildcard[key] = lane
	} else {
		registry.exact[key+"\x00"+lane.host] = lane
	}
	return nil
}
