package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Opt in only inside a disposable container without NET_ADMIN. This exercises
// the real GOST API, Agent collector, encrypted report retry and disk baselines.
func TestRestrictedGostTrafficReportingDoesNotReplay(t *testing.T) {
	binary := os.Getenv("FORWARDX_TEST_GOST_BINARY")
	if os.Getenv("FORWARDX_TEST_RESTRICTED_TRAFFIC") != "1" || binary == "" {
		t.Skip("requires the isolated restricted-container traffic lab")
	}
	if _, err := os.Stat("/.dockerenv"); err != nil || !detectKernelTrafficUnavailable() {
		t.Fatal("requires a disposable Linux container without NET_ADMIN")
	}
	useIsolatedTrafficState(t)
	oldCompact := compactAgentReports.Swap(false)
	t.Cleanup(func() { compactAgentReports.Store(oldCompact) })
	echo, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	free, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := free.Addr().String()
	_, port, _ := net.SplitHostPort(address)
	free.Close()
	state := localRuleState{RuleID: 42, Port: port, Protocol: "tcp", ForwardType: "gost"}
	for _, dir := range []string{gostAPIDir, agentStateDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	socket := filepath.Join(gostAPIDir, runtimeServiceName+".sock")
	if _, err := os.Lstat(socket); !os.IsNotExist(err) {
		t.Fatal("refusing to replace an existing runtime socket")
	}
	marker := filepath.Join(agentStateDir, "port_"+port+".rule")
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatal("refusing to replace an existing rule marker")
	}
	if err := os.WriteFile(marker, []byte("42"), 0644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(marker)
	// Production discovers rules and persists baselines in the same directory.
	// The baseline helper redirects only the latter, so mirror its owner marker.
	if err := os.WriteFile(filepath.Join(trafficStateDir, "port_"+port+".rule"), []byte("42"), 0644); err != nil {
		t.Fatal(err)
	}
	rememberDesiredRunningRules([]runningRule{{RuleID: 42, SourcePort: parseStatePort(port), Protocol: "tcp", ForwardType: "gost"}})
	defer rememberDesiredRunningRules(nil)
	config := map[string]any{
		"api": map[string]any{"addr": "unix://" + socket},
		"services": []any{map[string]any{
			"name": "fwx-42-tcp", "addr": address,
			"metadata": map[string]any{"enableStats": true, "observer.resetTraffic": false},
			"handler":  map[string]any{"type": "tcp"}, "listener": map[string]any{"type": "tcp"},
			"forwarder": map[string]any{"nodes": []any{map[string]any{"name": "target", "addr": echo.Addr().String()}}},
		}},
	}
	configPath := filepath.Join(t.TempDir(), "gost.json")
	raw, _ := json.Marshal(config)
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	var process *exec.Cmd
	var sentBytes uint64
	stop := func() {
		if process != nil {
			_ = process.Process.Kill()
			_ = process.Wait()
			process = nil
		}
		_ = os.Remove(socket)
	}
	defer stop()
	start := func() {
		sentBytes = 0
		process = exec.Command(binary, "-C", configPath)
		if err := process.Start(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for len(gostNativeTrafficSnapshot([]localRuleState{state})) != 1 {
			if time.Now().After(deadline) {
				t.Fatal("real GOST did not expose a complete idle statistics sample")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	type stat struct {
		RuleID      int    `json:"ruleId"`
		BytesIn     uint64 `json:"bytesIn"`
		BytesOut    uint64 `json:"bytesOut"`
		Connections uint64 `json:"connections"`
	}
	type report struct {
		ID    string `json:"reportId"`
		Stats []stat `json:"stats"`
	}
	var reports []report
	var reportsMu sync.Mutex
	var rejectNext atomic.Bool
	const token = "restricted-gost-isolated-token"
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request envelope
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			http.Error(w, "bad request", 400)
			return
		}
		plain, err := decrypt(request, token)
		var body struct {
			Path    string `json:"path"`
			Payload report `json:"payload"`
		}
		if err != nil || json.Unmarshal(plain, &body) != nil || body.Path != "/api/agent/traffic" {
			t.Errorf("unexpected encrypted traffic request: %v", err)
			http.Error(w, "bad request", 400)
			return
		}
		reportsMu.Lock()
		if len(body.Payload.Stats) > 0 {
			reports = append(reports, body.Payload)
		}
		reportsMu.Unlock()
		if rejectNext.Swap(false) {
			http.Error(w, "temporary failure", 503)
			return
		}
		response, _ := encrypt(map[string]any{"success": true}, token)
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer panel.Close()
	cfg := Config{PanelURL: panel.URL, Token: token, Interval: 30}
	collect := func() {
		// Advance only the report deadline; do not wait through a real batching
		// window between controlled traffic bursts.
		lastRuleTrafficReportAt = time.Time{}
		collectTraffic(cfg)
	}

	checkReports := func(wantCount int, wantLast uint64) {
		t.Helper()
		reportsMu.Lock()
		defer reportsMu.Unlock()
		if len(reports) != wantCount {
			t.Fatalf("traffic report count=%d, want=%d: %+v", len(reports), wantCount, reports)
		}
		if wantCount > 0 {
			last := reports[len(reports)-1]
			if len(last.Stats) != 1 || last.Stats[0].RuleID != 42 || last.Stats[0].BytesIn != wantLast || last.Stats[0].BytesOut != wantLast {
				t.Fatalf("wrong rule/delta: %+v", last)
			}
		}
	}
	send := func(payload string) {
		t.Helper()
		client, err := net.DialTimeout("tcp4", address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		_ = client.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := io.WriteString(client, payload); err != nil {
			t.Fatal(err)
		}
		if _, err := io.ReadFull(client, make([]byte, len(payload))); err != nil {
			t.Fatal(err)
		}
		sentBytes += uint64(len(payload))
		deadline := time.Now().Add(time.Second)
		for {
			sample := gostNativeTrafficSnapshot([]localRuleState{state})[port]
			if sample.counters.In == sentBytes && sample.counters.Out == sentBytes {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("GOST reply statistics did not settle")
			}
			time.Sleep(time.Millisecond)
		}
	}
	start()
	collect()
	initial := readPrevState(port)
	if initial.byteSource != trafficSourceGostNative || initial.in != 0 || initial.out != 0 {
		t.Fatalf("zero native baseline missing: %+v", initial)
	}
	send("payload")
	rejectNext.Store(true)
	collect()
	checkReports(1, 7)
	if readPrevState(port) != initial {
		t.Fatal("failed report advanced the traffic baseline")
	}
	collect()
	checkReports(2, 7)
	reportsMu.Lock()
	sameReport := reports[0].ID != "" && reports[0].ID == reports[1].ID
	reportsMu.Unlock()
	if !sameReport {
		t.Fatal("retry changed the deduplication identity")
	}
	trafficPrevMu.Lock()
	trafficPrevCache = map[string]trafficPrevState{}
	trafficPrevMu.Unlock()
	collect()
	checkReports(2, 7)
	send("next")
	collect()
	checkReports(3, 4)
	previousEpoch := readPrevState(port).byteEpoch
	stop()
	start()
	send("larger-after-restart")
	collect()
	checkReports(3, 4)
	if readPrevState(port).byteEpoch == previousEpoch {
		t.Fatal("runtime restart reused the old counter epoch")
	}
	send("new")
	collect()
	checkReports(4, 3)
	last := readPrevState(port)
	stop()
	collect()
	checkReports(4, 3)
	if readPrevState(port) != last {
		t.Fatal("unavailable API overwrote a valid baseline with zero")
	}
	t.Log("real GOST without NET_ADMIN: idle zero, 7/7 retry, 4/4 after Agent cache reload, runtime epoch reset, 3/3 new traffic, API failure preserved baseline on port " + port)
}
