package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Native nftables forwarding is only ready when the whole path ForwardX owns is
// in the kernel and nothing the host runs beside it drops the traffic. Docker
// leaves a default-DROP FORWARD base chain that an ACCEPT in the ForwardX table
// cannot override, so the panel installs scoped allowances in DOCKER-USER
// (see buildDockerForwardCompatCmds in server/agentActionCommands.ts). The
// checks below read the same kernel state back; the comment naming scheme
// fwx-docker-<rule>-<port>-<proto>-<in|out> is the contract between the two.

const (
	dockerCompatChain       = "DOCKER-USER"
	kernelIPv4ForwardPath   = "/proc/sys/net/ipv4/ip_forward"
	kernelLegacyTablesPath  = "/proc/net/ip_tables_names"
	dockerCompatCommandWait = 5 * time.Second
)

// kernelForwardEnv replaces the host probes of a snapshot. A nil env reads the
// real host; tests inject a described host instead.
type kernelForwardEnv struct {
	readFile    func(path string) ([]byte, error)
	hasCommand  func(name string) bool
	runIptables func(binary string, args ...string) ([]byte, error)
}

type dockerCompatFrontState struct {
	active   bool
	rules    []string
	rulesErr error
}

func (s *kernelForwardSnapshot) readHostFile(path string) ([]byte, error) {
	if s != nil && s.env != nil && s.env.readFile != nil {
		return s.env.readFile(path)
	}
	return os.ReadFile(path)
}

func (s *kernelForwardSnapshot) hasHostCommand(name string) bool {
	if s != nil && s.env != nil && s.env.hasCommand != nil {
		return s.env.hasCommand(name)
	}
	return commandExists(name)
}

func (s *kernelForwardSnapshot) runHostIptables(binary string, args ...string) ([]byte, error) {
	if s != nil && s.env != nil && s.env.runIptables != nil {
		return s.env.runIptables(binary, args...)
	}
	return commandOutputWithTimeout(dockerCompatCommandWait, binary, args...)
}

// dockerCompatFrontEnds lists the iptables front ends whose tables the kernel
// evaluates. They do not share rules: iptables-legacy can show ACCEPT while the
// nft front end drops, so each one is judged by its own FORWARD chain. Legacy
// tables are read only when already loaded; listing them would load the kernel
// module on hosts that never used them.
func (s *kernelForwardSnapshot) dockerCompatFrontEnds() []string {
	if s.dockerFrontEnds != nil {
		return s.dockerFrontEnds
	}
	fronts := []string{}
	for _, candidate := range []string{"iptables-nft", "iptables-legacy"} {
		if !s.hasHostCommand(candidate) {
			continue
		}
		if candidate == "iptables-legacy" && !s.legacyFilterTableLoaded() {
			continue
		}
		fronts = append(fronts, candidate)
	}
	if len(fronts) == 0 && s.hasHostCommand("iptables") {
		fronts = append(fronts, "iptables")
	}
	s.dockerFrontEnds = fronts
	return fronts
}

func (s *kernelForwardSnapshot) legacyFilterTableLoaded() bool {
	raw, err := s.readHostFile(kernelLegacyTablesPath)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "filter" {
			return true
		}
	}
	return false
}

// dockerCompatFront reports whether the front end drops FORWARD by default and
// hands traffic to DOCKER-USER, the structure the allowances are made for. Any
// other structure (a plain ACCEPT policy, ufw or an administrator's own
// layout) is deliberately not judged.
func (s *kernelForwardSnapshot) dockerCompatFront(binary string) *dockerCompatFrontState {
	if state, ok := s.dockerFronts[binary]; ok {
		return state
	}
	if s.dockerFronts == nil {
		s.dockerFronts = map[string]*dockerCompatFrontState{}
	}
	state := &dockerCompatFrontState{}
	s.dockerFronts[binary] = state
	forward, err := s.runHostIptables(binary, "-w", "5", "-S", "FORWARD")
	if err != nil {
		return state
	}
	dropsByDefault, jumpsToDocker := false, false
	for _, rawLine := range strings.Split(string(forward), "\n") {
		line := kernelNormalizeLine(rawLine)
		if line == "-P FORWARD DROP" {
			dropsByDefault = true
		}
		if strings.HasPrefix(line, "-A FORWARD ") && strings.HasSuffix(line, " -j "+dockerCompatChain) {
			jumpsToDocker = true
		}
	}
	if !dropsByDefault || !jumpsToDocker {
		return state
	}
	state.active = true
	rules, err := s.runHostIptables(binary, "-w", "5", "-S", dockerCompatChain)
	if err != nil {
		state.rulesErr = err
		return state
	}
	for _, rawLine := range strings.Split(string(rules), "\n") {
		if line := kernelNormalizeLine(rawLine); strings.HasPrefix(line, "-A "+dockerCompatChain+" ") {
			state.rules = append(state.rules, line)
		}
	}
	return state
}

type dockerCompatSpec struct {
	proto      string
	direction  string
	comment    string
	targetIP   string
	targetPort int
	sourcePort int
}

func dockerCompatSpecsFor(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) []dockerCompatSpec {
	target := net.ParseIP(kernelCleanAddress(targetIP))
	if target == nil || target.To4() == nil || targetPort <= 0 || sourcePort <= 0 {
		return nil
	}
	specs := []dockerCompatSpec{}
	for _, proto := range runtimeProtocols(protocol) {
		for _, direction := range []string{"in", "out"} {
			specs = append(specs, dockerCompatSpec{
				proto:      proto,
				direction:  direction,
				comment:    fmt.Sprintf("fwx-docker-%d-%d-%s-%s", ruleID, sourcePort, proto, direction),
				targetIP:   target.String(),
				targetPort: targetPort,
				sourcePort: sourcePort,
			})
		}
	}
	return specs
}

// matches compares what iptables prints back with what the spec requires, so a
// stale allowance for another target or port, or a same-named rule with a
// different verdict, never counts.
func (spec dockerCompatSpec) matches(line string) bool {
	fields := strings.Fields(line)
	if len(fields) < 3 || fields[0] != "-A" || fields[1] != dockerCompatChain {
		return false
	}
	has := func(flag string, values ...string) bool {
		for index := 0; index+1 < len(fields); index++ {
			if fields[index] != flag {
				continue
			}
			for _, value := range values {
				if fields[index+1] == value {
					return true
				}
			}
		}
		return false
	}
	address := func(flag string) bool { return has(flag, spec.targetIP, spec.targetIP+"/32") }
	if !has("--comment", spec.comment, `"`+spec.comment+`"`) || !has("-j", "ACCEPT") || !has("-p", spec.proto) ||
		!has("--ctorigdstport", strconv.Itoa(spec.sourcePort)) {
		return false
	}
	if spec.direction == "in" {
		return address("-d") && has("--dport", strconv.Itoa(spec.targetPort))
	}
	if !address("-s") || !has("--sport", strconv.Itoa(spec.targetPort)) || !has("--ctdir", "REPLY") {
		return false
	}
	for index := 0; index+1 < len(fields); index++ {
		if fields[index] == "--ctstate" {
			states := strings.Split(fields[index+1], ",")
			return containsString(states, "ESTABLISHED") && containsString(states, "RELATED")
		}
	}
	return false
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// dockerCompatMissingReason returns why a required DOCKER-USER allowance is
// absent, or "" when every front end that needs one has it.
func (s *kernelForwardSnapshot) dockerCompatMissingReason(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) string {
	specs := dockerCompatSpecsFor(ruleID, sourcePort, targetIP, targetPort, protocol)
	if len(specs) == 0 {
		return ""
	}
	for _, binary := range s.dockerCompatFrontEnds() {
		state := s.dockerCompatFront(binary)
		if !state.active {
			continue
		}
		if state.rulesErr != nil {
			return fmt.Sprintf("%s: cannot read %s: %v", binary, dockerCompatChain, state.rulesErr)
		}
		for _, spec := range specs {
			found := false
			for _, line := range state.rules {
				if spec.matches(line) {
					found = true
					break
				}
			}
			if !found {
				return fmt.Sprintf("%s: %s allowance missing for %d/%s (%s); Docker's default-DROP FORWARD drops this traffic", binary, dockerCompatChain, sourcePort, spec.proto, spec.direction)
			}
		}
	}
	return ""
}

// dockerCompatStaleReason reports an allowance that the current specification
// does not call for: one of this rule's allowances for another target, port or
// protocol, or another rule's allowance for the very port and protocol this
// rule now owns. Such leftovers keep a retired path open, so the rule has not
// converged yet.
func (s *kernelForwardSnapshot) dockerCompatStaleReason(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) string {
	wanted := dockerCompatSpecsFor(ruleID, sourcePort, targetIP, targetPort, protocol)
	protocols := runtimeProtocols(protocol)
	for _, binary := range s.dockerCompatFrontEnds() {
		state := s.dockerCompatFront(binary)
		if !state.active || state.rulesErr != nil {
			continue
		}
		for _, line := range state.rules {
			commentRule, commentPort, commentProto, ok := dockerCompatLineOwner(line)
			if !ok {
				continue
			}
			ownedByRule := ruleID > 0 && commentRule == ruleID
			conflictingOwner := sourcePort > 0 && commentPort == sourcePort && commentRule != ruleID && containsString(protocols, commentProto)
			if !ownedByRule && !conflictingOwner {
				continue
			}
			matched := false
			for _, spec := range wanted {
				if spec.matches(line) {
					matched = true
					break
				}
			}
			if !matched {
				return fmt.Sprintf("%s: a stale %s allowance remains: %s", binary, dockerCompatChain, line)
			}
		}
	}
	return ""
}

// nftLineOwnedByRule tells whether a rule line carries the comment of the
// given rule: fwx-rule-<id>, fwx-rule-<id>-in|out or a fallback fwx-rule-<id>:…
func nftLineOwnedByRule(line string, ruleID int) bool {
	if ruleID <= 0 {
		return false
	}
	for _, suffix := range []string{`"`, `-`, `:`} {
		if strings.Contains(line, fmt.Sprintf(`comment "fwx-rule-%d%s`, ruleID, suffix)) {
			return true
		}
	}
	return false
}

// nftStaleProtocolReason reports ForwardX state of this rule for a protocol it
// no longer asks for.
func nftStaleProtocolReason(text string, ruleID int, protocol string) string {
	if ruleID <= 0 {
		return ""
	}
	for _, proto := range []string{"tcp", "udp"} {
		if containsString(runtimeProtocols(protocol), proto) {
			continue
		}
		for _, chain := range []string{"prerouting", "forward"} {
			for _, line := range nftChainLines(text, chain) {
				if nftLineOwnedByRule(line, ruleID) && (strings.Contains(line, " "+proto+" dport ") || strings.Contains(line, " "+proto+" sport ")) {
					return fmt.Sprintf("a stale %s rule of rule %d remains in the %s chain", proto, ruleID, chain)
				}
			}
		}
	}
	return ""
}

// dockerCompatResidue reports whether any front end still holds an allowance
// owned by the rule or the port.
func (s *kernelForwardSnapshot) dockerCompatResidue(ruleID int, sourcePort int, protocol string) bool {
	protocols := runtimeProtocols(protocol)
	for _, binary := range s.dockerCompatFrontEnds() {
		rules, err := s.runHostIptables(binary, "-w", "5", "-S", dockerCompatChain)
		if err != nil {
			continue
		}
		for _, rawLine := range strings.Split(string(rules), "\n") {
			if dockerCompatLineOwnedBy(kernelNormalizeLine(rawLine), ruleID, sourcePort, protocols) {
				return true
			}
		}
	}
	return false
}

// dockerCompatLineOwner extracts rule, port and protocol from the comment of an
// allowance ForwardX installed; other DOCKER-USER rules have no such comment.
func dockerCompatLineOwner(line string) (ruleID int, sourcePort int, proto string, ok bool) {
	if !strings.HasPrefix(line, "-A "+dockerCompatChain+" ") {
		return 0, 0, "", false
	}
	for _, field := range strings.Fields(line) {
		comment := strings.Trim(field, `"`)
		if !strings.HasPrefix(comment, "fwx-docker-") {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(comment, "fwx-docker-"), "-")
		if len(parts) != 4 || (parts[2] != "tcp" && parts[2] != "udp") {
			continue
		}
		ruleID, ruleErr := strconv.Atoi(parts[0])
		sourcePort, portErr := strconv.Atoi(parts[1])
		if ruleErr == nil && portErr == nil {
			return ruleID, sourcePort, parts[2], true
		}
	}
	return 0, 0, "", false
}

func dockerCompatLineOwnedBy(line string, ruleID int, sourcePort int, protocols []string) bool {
	commentRule, commentPort, commentProto, ok := dockerCompatLineOwner(line)
	if !ok {
		return false
	}
	return (ruleID > 0 && commentRule == ruleID) ||
		(sourcePort > 0 && commentPort == sourcePort && containsString(protocols, commentProto))
}

// nftChainLines returns the rule lines of one chain in `nft -a list table`.
func nftChainLines(text string, chain string) []string {
	lines := []string{}
	inChain := false
	for _, rawLine := range strings.Split(text, "\n") {
		line := kernelNormalizeLine(rawLine)
		switch {
		case strings.HasPrefix(line, "chain "+chain+" {"):
			inChain = true
		case inChain && line == "}":
			return lines
		case inChain && line != "" && !strings.HasPrefix(line, "type "):
			lines = append(lines, line)
		}
	}
	return lines
}

func (s *kernelForwardSnapshot) ipv4ForwardingEnabled() bool {
	raw, err := s.readHostFile(kernelIPv4ForwardPath)
	return err == nil && strings.TrimSpace(string(raw)) == "1"
}

// nftForwardRuleNotReadyReason explains why a native nftables rule cannot
// forward right now, or returns "" when every condition ForwardX can verify is
// met. It judges the local configuration only: a target that is down or an
// unreachable network never makes a correctly configured entry "not ready".
func (s *kernelForwardSnapshot) nftForwardRuleNotReadyReason(ruleID int, sourcePort int, targetIP string, targetPort int, protocol string) string {
	text := s.nftTableText()
	if text == "" {
		return "the forwardx nftables table is missing"
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !nftDnatLinePresent(text, ruleID, proto, sourcePort, targetIP, targetPort) {
			return fmt.Sprintf("the %s DNAT rule for port %d is missing", proto, sourcePort)
		}
	}
	target := net.ParseIP(kernelCleanAddress(targetIP))
	if target == nil || target.To4() == nil {
		// IPv6 and unresolved targets keep their earlier, DNAT-only meaning.
		return ""
	}
	if !s.ipv4ForwardingEnabled() {
		return "net.ipv4.ip_forward is not enabled"
	}
	if !nftMasqueradePresent(text, ruleID, target.String(), targetPort, protocol) {
		return "the source address translation (masquerade) rule is missing"
	}
	for _, proto := range runtimeProtocols(protocol) {
		if !nftForwardAcceptPresent(text, "daddr", "dport", proto, target.String(), targetPort) {
			return fmt.Sprintf("the %s forward accept for %s:%d is missing", proto, target.String(), targetPort)
		}
		if !nftForwardAcceptPresent(text, "saddr", "sport", proto, target.String(), targetPort) {
			return fmt.Sprintf("the %s return accept for %s:%d is missing", proto, target.String(), targetPort)
		}
	}
	if reason := nftStaleProtocolReason(text, ruleID, protocol); reason != "" {
		return reason
	}
	if reason := s.dockerCompatMissingReason(ruleID, sourcePort, target.String(), targetPort, protocol); reason != "" {
		return reason
	}
	return s.dockerCompatStaleReason(ruleID, sourcePort, target.String(), targetPort, protocol)
}

func nftMasqueradePresent(text string, ruleID int, targetIP string, targetPort int, protocol string) bool {
	lines := nftChainLines(text, "postrouting")
	for _, line := range lines {
		if strings.Contains(line, "masquerade") && strings.Contains(line, "ct status dnat") {
			return true
		}
	}
	for _, proto := range runtimeProtocols(protocol) {
		found := false
		for _, line := range lines {
			if !strings.Contains(line, "masquerade") {
				continue
			}
			if (ruleID > 0 && strings.Contains(line, fmt.Sprintf("fwx-rule-%d-masquerade-%s", ruleID, proto))) ||
				(strings.Contains(line, "ip daddr "+targetIP+" ") && strings.Contains(line, fmt.Sprintf("%s dport %d ", proto, targetPort))) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func nftForwardAcceptPresent(text string, addressKey string, portKey string, proto string, targetIP string, targetPort int) bool {
	for _, line := range nftChainLines(text, "forward") {
		if strings.Contains(line, " accept") &&
			strings.Contains(line, "ip "+addressKey+" "+targetIP+" ") &&
			strings.Contains(line, fmt.Sprintf("%s %s %d", proto, portKey, targetPort)) {
			return true
		}
	}
	return false
}

// cleanupDockerCompatAllowances removes the DOCKER-USER allowances owned by a
// rule id (any port and protocol it ever used) and by a port for the given
// protocols. The panel's removal commands do the same in shell; the Agent needs
// its own pass for the local cleanups it starts without a panel command, such
// as reconciling a rule the panel no longer lists. It returns false when an
// owned allowance could not be removed.
func cleanupDockerCompatAllowances(ruleID int, sourcePort int, protocols []string) bool {
	return newKernelForwardSnapshot().cleanupDockerCompatAllowances(ruleID, sourcePort, protocols)
}

func (s *kernelForwardSnapshot) cleanupDockerCompatAllowances(ruleID int, sourcePort int, protocols []string) bool {
	if ruleID <= 0 && sourcePort <= 0 {
		return true
	}
	ok := true
	for _, binary := range s.dockerCompatFrontEnds() {
		for round := 0; ; round++ {
			listing, err := s.runHostIptables(binary, "-w", "5", "-S", dockerCompatChain)
			if err != nil {
				break // no such chain (no Docker) or an unusable front end: nothing of ours can be there
			}
			positions := []int{}
			position := 0
			for _, rawLine := range strings.Split(string(listing), "\n") {
				line := kernelNormalizeLine(rawLine)
				if !strings.HasPrefix(line, "-A "+dockerCompatChain+" ") {
					continue
				}
				position++
				if dockerCompatLineOwnedBy(line, ruleID, sourcePort, protocols) {
					positions = append(positions, position)
				}
			}
			if len(positions) == 0 {
				break
			}
			if round >= 5 {
				logf("docker-compat: could not remove %d allowance(s) of rule=%d port=%d from %s via %s", len(positions), ruleID, sourcePort, dockerCompatChain, binary)
				ok = false
				break
			}
			// Highest position first so earlier positions stay valid.
			for index := len(positions) - 1; index >= 0; index-- {
				_, _ = s.runHostIptables(binary, "-w", "5", "-D", dockerCompatChain, strconv.Itoa(positions[index]))
			}
		}
	}
	return ok
}

// cleanupNftRuleState removes the kernel state a nftables rule owns: its
// ForwardX table entries and its Docker allowances.
func cleanupNftRuleState(ruleID int) {
	_ = runShell(nftRuleCleanupCmd(ruleID))
	cleanupDockerCompatAllowances(ruleID, 0, nil)
}

// cleanupNftPortState removes nftables DNAT for a port and the Docker
// allowances of that port for the given protocol.
func cleanupNftPortState(port string, protocol string) {
	_ = runShell(nftPortCleanupCmd(port, protocol))
	cleanupDockerCompatAllowances(0, atoi(port), runtimeProtocols(protocol))
}
