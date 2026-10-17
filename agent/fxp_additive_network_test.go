package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// These fixtures run real FXP processes and, for V2, two real userspace
// WireGuard peers. They do not install binaries or contact a panel.
func TestFXPRealAdditionsKeepTCPUDPAndProcessIdentity(t *testing.T) {
	binary := os.Getenv("FORWARDX_TEST_FXP_BINARY")
	if binary == "" {
		t.Skip("set FORWARDX_TEST_FXP_BINARY for real FXP process coverage")
	}
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) { verifyFXPRealAdditions(t, binary, version, false) })
	}
}

func TestFXPRealOldRuntimeRefusesAdditionAndKeepsBusiness(t *testing.T) {
	binary := os.Getenv("FORWARDX_TEST_OLD_FXP_BINARY")
	if binary == "" {
		t.Skip("set FORWARDX_TEST_OLD_FXP_BINARY for the same-version old runtime")
	}
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) { verifyFXPRealAdditions(t, binary, version, true) })
	}
}

func verifyFXPRealAdditions(t *testing.T, binary, version string, oldRuntime bool) {
	t.Helper()
	usePersistentRuntimeTestDirs(t)
	if _, err := os.Stat("/.dockerenv"); err != nil {
		t.Fatal("real runtime fixtures require an isolated Linux container")
	}
	previousResolver := resolveFXPRuntimeExecutable
	resolveFXPRuntimeExecutable = func() (string, error) { return binary, nil }
	t.Cleanup(func() { resolveFXPRuntimeExecutable = previousResolver })
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tcp.Close() })
	targetPort := tcp.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			c, err := tcp.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	udp, err := net.ListenPacket("udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { udp.Close() })
	go func() {
		buf := make([]byte, 128)
		for {
			n, peer, err := udp.ReadFrom(buf)
			if err != nil {
				return
			}
			udp.WriteTo(buf[:n], peer)
		}
	}()
	freePort := func() int {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer l.Close()
		return l.Addr().(*net.TCPAddr).Port
	}
	tunnelID := 98640
	if version == "v2" {
		tunnelID++
	}
	exitPort := freePort()
	if version == "v2" {
		leftPrivate, leftPublic := testWireGuardKeyPair(t)
		rightPrivate, rightPublic := testWireGuardKeyPair(t)
		wirePort := testUDPPort(t)
		right, err := newWireGuardRuntime(wireGuardSpec{TunnelID: tunnelID, PrivateKey: rightPrivate, PublicKey: rightPublic, Address: "100.109.0.2", ListenPort: wirePort, MTU: 1380, Peers: []wireGuardPeerSpec{{ID: "1", HostID: 1, PublicKey: leftPublic, Address: "100.109.0.1"}}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(right.close)
		if err := right.addRef("fixture-exit"); err != nil {
			t.Fatal(err)
		}
		if err := right.ensureInboundProxy("fixture-exit", exitPort, exitPort); err != nil {
			t.Fatal(err)
		}
		left, err := newWireGuardRuntime(wireGuardSpec{TunnelID: tunnelID, PrivateKey: leftPrivate, PublicKey: leftPublic, Address: "100.109.0.1", MTU: 1380, Peers: []wireGuardPeerSpec{{ID: "2", HostID: 2, PublicKey: rightPublic, Address: "100.109.0.2", EndpointHost: "127.0.0.1", EndpointPort: wirePort, PersistentKeepalive: 25}}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(left.close)
		setTestWireGuardRuntime(t, tunnelID, left)
	}
	exit := normalizeFXPSpec(fxpSpec{Role: "exit", TransportVersion: version, TunnelID: tunnelID, ListenHost: "127.0.0.1", ListenPort: exitPort, Protocol: "both", Key: "fixture-additive-key"})
	for ruleID := 1; ruleID <= 8; ruleID++ {
		exit.UDPTargets = append(exit.UDPTargets, fxpUDPTarget{RuleID: ruleID, TargetIP: "127.0.0.1", TargetPort: targetPort})
	}
	exitPath := filepath.Join(t.TempDir(), "exit.json")
	raw, _ := json.Marshal(exit)
	if err := os.WriteFile(exitPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	exitProcess := exec.Command(binary, "-config", exitPath)
	logFile, err := os.Create(filepath.Join(t.TempDir(), "runtime.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { logFile.Close() })
	exitProcess.Stdout, exitProcess.Stderr = logFile, logFile
	if err := exitProcess.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { exitProcess.Process.Kill(); exitProcess.Wait() })
	waitTCP := func(port int) net.Conn {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond)
			if err == nil {
				return c
			}
			if time.Now().After(deadline) {
				t.Fatal(err)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	probe := waitTCP(exitPort)
	probe.Close()
	entry := func(id int) fxpSpec {
		s := testV1EntrySpec(tunnelID, id, freePort())
		s.TransportVersion = version
		s.ExitHost = "127.0.0.1"
		s.ExitPeerID = "2"
		s.ExitPort = exitPort
		s.UDPExitPort = exitPort
		s.TargetIP = "127.0.0.1"
		s.TargetPort = targetPort
		s.Key = "fixture-additive-key"
		return s
	}
	first, second, third, fourth := entry(1), entry(2), entry(3), entry(4)
	cfg := Config{PanelURL: "http://127.0.0.1:9", Token: "fixture"}
	message := newActionMessage()
	initial, _ := buildSharedFXPEntryGroup([]fxpSpec{first}, tunnelID, version)
	if !startFXP(cfg, first, &initial, message) {
		t.Fatal(message.get())
	}
	id := fxpServerID(initial)
	fxpMu.Lock()
	process := fxpServers[id]
	fxpMu.Unlock()
	if process == nil || process.cmd == nil {
		t.Fatal("missing actual process")
	}
	pid := process.cmd.Process.Pid
	t.Cleanup(func() { stopFXPRuntime(initial) })
	checkEcho := func(c net.Conn) {
		t.Helper()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		if _, err := c.Write([]byte("still-alive")); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 11)
		if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "still-alive" {
			t.Fatalf("business interrupted: %q %v", buf, err)
		}
	}
	oldTCP := waitTCP(first.ListenPort)
	t.Cleanup(func() { oldTCP.Close() })
	oldUDP, err := net.Dial("udp", net.JoinHostPort("127.0.0.1", strconv.Itoa(first.ListenPort)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { oldUDP.Close() })
	check := func() {
		t.Helper()
		checkEcho(oldTCP)
		checkEcho(oldUDP)
		fxpMu.Lock()
		same := fxpServers[id] == process && process.cmd.Process.Pid == pid
		fxpMu.Unlock()
		if !same {
			t.Fatal("healthy shared process was replaced")
		}
	}
	check()
	next, _ := buildSharedFXPEntryGroup([]fxpSpec{first, second}, tunnelID, version)
	ok := startFXP(cfg, second, &next, message)
	if oldRuntime {
		if ok {
			t.Fatal("old runtime silently accepted unsupported addition")
		}
		check()
		t.Logf("old runtime version unchanged: %s pid=%d addition refused and TCP/UDP preserved", version, pid)
		return
	}
	if !ok {
		t.Fatal(message.get())
	}
	check()
	newTCP := waitTCP(second.ListenPort)
	checkEcho(newTCP)
	newTCP.Close()
	// Repeated requests and an older concurrent addition retain the sibling.
	if !startFXP(cfg, second, &next, message) {
		t.Fatal(message.get())
	}
	queued, _ := buildSharedFXPEntryGroup([]fxpSpec{first, third}, tunnelID, version)
	if !startFXP(cfg, third, &queued, message) {
		t.Fatal(message.get())
	}
	check()
	for _, port := range []int{second.ListenPort, third.ListenPort} {
		c := waitTCP(port)
		checkEcho(c)
		c.Close()
	}
	// Forward the next real update but drop its acknowledgement. The runtime has
	// committed; Agent must retain V2 preparations and retry without replacement.
	realSocket := process.configPath + ".sock.real"
	if err := os.Rename(process.configPath+".sock", realSocket); err != nil {
		t.Fatal(err)
	}
	proxy, err := net.Listen("unix", process.configPath+".sock")
	if err != nil {
		t.Fatal(err)
	}
	var dropped atomic.Bool
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second*5)
		defer cancel()
		if err := requestFXPAddition(ctx, realSocket, data); err != nil {
			http.Error(w, "fixture forward refused", http.StatusConflict)
			return
		}
		if !dropped.Swap(true) {
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})}
	go server.Serve(proxy)
	all, _ := buildSharedFXPEntryGroup([]fxpSpec{first, second, third, fourth}, tunnelID, version)
	if startFXP(cfg, fourth, &all, message) {
		t.Fatal("lost reply was reported as confirmed success")
	}
	check()
	fourthTCP := waitTCP(fourth.ListenPort)
	checkEcho(fourthTCP)
	fourthTCP.Close()
	// A sibling batch was captured before the fourth rule was saved. It must
	// retain that possibly committed rule while adding its own fifth member.
	fifth := entry(5)
	olderBatch, _ := buildSharedFXPEntryGroup([]fxpSpec{first, second, third, fifth}, tunnelID, version)
	if !startFXP(cfg, fifth, &olderBatch, message) {
		t.Fatalf("lost-reply sibling was not retained: %s", message.get())
	}
	all, _ = buildSharedFXPEntryGroup([]fxpSpec{first, second, third, fourth, fifth}, tunnelID, version)
	for _, port := range []int{fourth.ListenPort, fifth.ListenPort} {
		c := waitTCP(port)
		checkEcho(c)
		c.Close()
	}
	server.Close()
	os.Remove(process.configPath + ".sock")
	if err := os.Rename(realSocket, process.configPath+".sock"); err != nil {
		t.Fatal(err)
	}
	if !startFXP(cfg, fourth, &all, message) {
		t.Fatal(message.get())
	}
	check()
	// The live update precedes persistence. Obstruct only the fixture snapshot
	// directory, then ensure the new listener survives and a retry converges.
	sixth := entry(6)
	withFifth, _ := buildSharedFXPEntryGroup(append(append([]fxpSpec(nil), all.Entries...), sixth), tunnelID, version)
	backupDir := persistentFXPDir + ".backup"
	if err := os.Rename(persistentFXPDir, backupDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(persistentFXPDir, []byte("fixture-save-failure"), 0600); err != nil {
		t.Fatal(err)
	}
	if startFXP(cfg, sixth, &withFifth, message) {
		t.Fatal("persistence failure reported success")
	}
	check()
	fifthTCP := waitTCP(sixth.ListenPort)
	checkEcho(fifthTCP)
	fifthTCP.Close()
	os.Remove(persistentFXPDir)
	if err := os.Rename(backupDir, persistentFXPDir); err != nil {
		t.Fatal(err)
	}
	if !startFXP(cfg, sixth, &withFifth, message) {
		t.Fatal(message.get())
	}
	check()
	all = withFifth
	// A definite port conflict affects only the attempted addition.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	bad := entry(7)
	bad.ListenPort = occupied.Addr().(*net.TCPAddr).Port
	conflict, _ := buildSharedFXPEntryGroup(append(append([]fxpSpec(nil), all.Entries...), bad), tunnelID, version)
	if startFXP(cfg, bad, &conflict, message) {
		t.Fatal("occupied port accepted")
	}
	check()
	// An explicit removal also works before an applied addition has been
	// confirmed on disk. Removal may replace the shared process.
	pendingEntry := entry(8)
	pendingGroup, _ := buildSharedFXPEntryGroup(append(append([]fxpSpec(nil), all.Entries...), pendingEntry), tunnelID, version)
	if err := os.Rename(persistentFXPDir, backupDir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(persistentFXPDir, []byte("fixture-save-failure"), 0600); err != nil {
		t.Fatal(err)
	}
	if startFXP(cfg, pendingEntry, &pendingGroup, message) {
		t.Fatal("unconfirmed addition reported success")
	}
	pendingTCP := waitTCP(pendingEntry.ListenPort)
	checkEcho(pendingTCP)
	pendingTCP.Close()
	os.Remove(persistentFXPDir)
	if err := os.Rename(backupDir, persistentFXPDir); err != nil {
		t.Fatal(err)
	}
	if !stopFXP(pendingEntry, &all, message) {
		t.Fatalf("explicit removal failed: %s", message.get())
	}
	if c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(pendingEntry.ListenPort)), time.Second); err == nil {
		c.Close()
		t.Fatal("explicitly removed unconfirmed listener survived")
	}
	remaining := waitTCP(first.ListenPort)
	checkEcho(remaining)
	remaining.Close()
	t.Logf("real %s entry pid=%d exit pid=%d: TCP/UDP, additions, retry, out-of-order, lost reply and conflict passed", version, pid, exitProcess.Process.Pid)
}
