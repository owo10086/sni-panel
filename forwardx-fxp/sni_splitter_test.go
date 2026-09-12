package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestSniSplitterForwardsMatchingClientHelloUnchanged(t *testing.T) {
	hello := clientHelloBytes(t, "api.example.com")
	backendPort, received, stopBackend := startRecordingTCPBackend(t, len(hello))
	defer stopBackend()
	splitterPort, stopSplitter := startTestSniSplitter(t, []sniRoute{{
		SNI:        "api.example.com",
		RuleID:     42,
		TargetIP:   "127.0.0.1",
		TargetPort: backendPort,
	}})
	defer stopSplitter()

	client := dialTestTCP(t, splitterPort)
	defer client.Close()
	if _, err := client.Write(hello); err != nil {
		t.Fatal(err)
	}

	got := receiveBytes(t, received)
	if !bytes.Equal(got, hello) {
		t.Fatalf("backend received changed ClientHello: got %d bytes want %d bytes", len(got), len(hello))
	}
}

func TestSniSplitterForwardsClientHelloWithECHUsingReadableSNIUnchanged(t *testing.T) {
	tests := []struct {
		name     string
		position tlsExtensionPosition
		data     []byte
	}{
		{name: "first extension", position: tlsExtensionFirst, data: []byte{0x9d, 0x2f, 0x81, 0x44}},
		{name: "middle extension", position: tlsExtensionMiddle, data: []byte{0x00, 0x01, 0x02, 0x03, 0x04}},
		{name: "last extension", position: tlsExtensionLast, data: []byte{0x6a, 0xc3, 0x17}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hello := insertTLSClientHelloExtension(t, clientHelloBytes(t, "api.example.com"), 0xfe0d, tt.data, tt.position)
			backendPort, received, stopBackend := startRecordingTCPBackend(t, len(hello))
			defer stopBackend()
			controlSocketPath := testUnixSocketPath(t)
			cfg := normalizeConfig(config{
				Role:              "sni-splitter",
				ListenPort:        freeTCPPort(t),
				Protocol:          "tcp",
				SNIRouteVersion:   1,
				ControlSocketPath: controlSocketPath,
				SNIRoutes: []sniRoute{{
					SNI:        "api.example.com",
					RuleID:     42,
					TargetIP:   "127.0.0.1",
					TargetPort: backendPort,
				}},
			})
			splitterPort, stopSplitter := startTestSniSplitterWithConfig(t, cfg)
			defer stopSplitter()
			waitForSNIUnmatchedConnections(t, controlSocketPath, 1)

			client := dialTestTCP(t, splitterPort)
			defer client.Close()
			if _, err := client.Write(hello); err != nil {
				t.Fatal(err)
			}

			got := receiveBytes(t, received)
			if !bytes.Equal(got, hello) {
				t.Fatalf("backend received changed ClientHello with ECH: got %d bytes want %d bytes", len(got), len(hello))
			}
			if status := getSNIRouteTableStatus(t, controlSocketPath); status.UnmatchedConnections != 1 {
				t.Fatalf("ECH route changed unmatched connections to %d, want 1", status.UnmatchedConnections)
			}
		})
	}
}

func TestSniSplitterRejectsUnmatchedTraffic(t *testing.T) {
	hello := clientHelloBytes(t, "api.example.com")
	noSNI := clientHelloBytes(t, "")

	tests := []struct {
		name    string
		payload []byte
	}{
		{name: "unknown sni", payload: clientHelloBytes(t, "www.example.com")},
		{name: "without sni", payload: noSNI},
		{name: "plain http", payload: []byte("GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n")},
		{name: "malformed extension length", payload: withBadTLSExtensionsLength(t, hello, 0xffff)},
		{name: "oversized record length", payload: []byte{0x16, 0x03, 0x01, 0xff, 0xff}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			splitterPort, stopSplitter := startTestSniSplitter(t, []sniRoute{{
				SNI:        "api.example.com",
				RuleID:     42,
				TargetIP:   "127.0.0.1",
				TargetPort: freeTCPPort(t),
			}})
			defer stopSplitter()

			client := dialTestTCP(t, splitterPort)
			defer client.Close()
			if _, err := client.Write(tt.payload); err != nil {
				t.Fatal(err)
			}
			expectTCPClosed(t, client)
		})
	}
}

func TestSniSplitterRejectsIncompleteHandshakeWithinReadWindow(t *testing.T) {
	oldTimeout := sniSplitterReadTimeout
	sniSplitterReadTimeout = 80 * time.Millisecond
	defer func() { sniSplitterReadTimeout = oldTimeout }()

	splitterPort, stopSplitter := startTestSniSplitter(t, []sniRoute{{
		SNI:        "api.example.com",
		RuleID:     42,
		TargetIP:   "127.0.0.1",
		TargetPort: freeTCPPort(t),
	}})
	defer stopSplitter()

	client := dialTestTCP(t, splitterPort)
	defer client.Close()
	if _, err := client.Write([]byte{0x16, 0x03, 0x01, 0x00, 0x40}); err != nil {
		t.Fatal(err)
	}
	expectTCPClosed(t, client)
}

func TestSniSplitterReassemblesFragmentedClientHello(t *testing.T) {
	hello := clientHelloWithECHBytes(t, "api.example.com")
	backendPort, received, stopBackend := startRecordingTCPBackend(t, len(hello))
	defer stopBackend()
	splitterPort, stopSplitter := startTestSniSplitter(t, []sniRoute{{
		SNI:        "api.example.com",
		RuleID:     42,
		TargetIP:   "127.0.0.1",
		TargetPort: backendPort,
	}})
	defer stopSplitter()

	client := dialTestTCP(t, splitterPort)
	defer client.Close()
	for _, chunk := range [][]byte{hello[:3], hello[3:17], hello[17:]} {
		if _, err := client.Write(chunk); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	got := receiveBytes(t, received)
	if !bytes.Equal(got, hello) {
		t.Fatalf("backend received changed fragmented ClientHello: got %d bytes want %d bytes", len(got), len(hello))
	}
}

func TestSniSplitterRoutesMultipleDomainsAndReportsTrafficByRule(t *testing.T) {
	resetTrafficBatchesForTest()
	t.Cleanup(resetTrafficBatchesForTest)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer panel.Close()

	apiHello := clientHelloWithECHBytes(t, "api.example.com")
	apiPayload := []byte("api request bytes")
	apiResponse := []byte("api response bytes")
	apiBackendPort, apiReceived, stopAPIBackend := startReplyingTCPBackend(t, len(apiHello)+len(apiPayload), apiResponse)
	defer stopAPIBackend()

	webHello := clientHelloWithECHBytes(t, "web.example.com")
	webPayload := []byte("web request payload")
	webResponse := []byte("web response payload")
	webBackendPort, webReceived, stopWebBackend := startReplyingTCPBackend(t, len(webHello)+len(webPayload), webResponse)
	defer stopWebBackend()

	cfg := normalizeConfig(config{
		Role:            "sni-splitter",
		ListenPort:      freeTCPPort(t),
		Protocol:        "tcp",
		PanelURL:        panel.URL,
		Token:           "traffic-test-token",
		RuleID:          900,
		SNIRouteVersion: 1,
		SNIRoutes: []sniRoute{
			{SNI: "api.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: apiBackendPort},
			{SNI: "web.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: webBackendPort},
		},
	})
	splitterPort, stopSplitter := startTestSniSplitterWithConfig(t, cfg)
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(stopSplitter) }
	defer stop()

	exchangeThroughSniSplitter(t, splitterPort, apiHello, apiPayload, apiResponse)
	exchangeThroughSniSplitter(t, splitterPort, webHello, webPayload, webResponse)

	if got := receiveBytes(t, apiReceived); !bytes.Equal(got, append(append([]byte(nil), apiHello...), apiPayload...)) {
		t.Fatalf("api backend received wrong payload")
	}
	if got := receiveBytes(t, webReceived); !bytes.Equal(got, append(append([]byte(nil), webHello...), webPayload...)) {
		t.Fatalf("web backend received wrong payload")
	}

	cfg.ListenPort = splitterPort
	key := trafficBatchKey{panelURL: panel.URL, token: cfg.Token, producerID: fxpTrafficProducerID(cfg)}
	trafficBatchFlushMu.Lock()
	stop()
	pending := trafficBatchPendingSnapshot()[key]
	trafficBatchFlushMu.Unlock()
	if len(pending.byRule) != 2 {
		t.Fatalf("sni splitter traffic batch rules = %d, want 2: %+v", len(pending.byRule), pending.byRule)
	}
	if got := pending.byRule[101]; got.bytesIn != uint64(len(apiHello)+len(apiPayload)) || got.bytesOut != uint64(len(apiResponse)) || got.connections != 1 {
		t.Fatalf("api traffic = %+v", got)
	}
	if got := pending.byRule[202]; got.bytesIn != uint64(len(webHello)+len(webPayload)) || got.bytesOut != uint64(len(webResponse)) || got.connections != 1 {
		t.Fatalf("web traffic = %+v", got)
	}
}

func TestSniSplitterHotSwapsRouteTableWithoutRestartingUnchangedRules(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix control sockets are not available on windows")
	}
	apiHello := clientHelloWithECHBytes(t, "api.example.com")
	webHello := clientHelloWithECHBytes(t, "web.example.com")
	apiBackendPort, stopAPIBackend := startPersistentSNIBackend(t, len(apiHello), "api-v1")
	defer stopAPIBackend()
	webBackendPort, stopWebBackend := startPersistentSNIBackend(t, len(webHello), "web-v1")
	defer stopWebBackend()
	webBackendPortV2, stopWebBackendV2 := startPersistentSNIBackend(t, len(webHello), "web-v2")
	defer stopWebBackendV2()

	cfg := normalizeConfig(config{
		Role:              "sni-splitter",
		ListenPort:        freeTCPPort(t),
		Protocol:          "tcp",
		SNIRouteVersion:   1,
		ControlSocketPath: testUnixSocketPath(t),
		SNIRoutes: []sniRoute{{
			SNI:        "api.example.com",
			RuleID:     101,
			TargetIP:   "127.0.0.1",
			TargetPort: apiBackendPort,
		}},
	})
	splitterPort, stopSplitter := startTestSniSplitterWithConfig(t, cfg)
	defer stopSplitter()

	apiClient := openSniSplitterSession(t, splitterPort, apiHello, []byte("api-before"), []byte("api-v1:api-before"))
	defer apiClient.Close()
	sendSNIRouteTableUpdate(t, cfg.ControlSocketPath, 2, []sniRoute{
		{SNI: "api.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: apiBackendPort},
		{SNI: "web.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: webBackendPort},
	})
	expectSNIBackendReply(t, apiClient, []byte("api-after-add"), []byte("api-v1:api-after-add"))

	webClient := openSniSplitterSession(t, splitterPort, webHello, []byte("web-before"), []byte("web-v1:web-before"))
	defer webClient.Close()
	sendSNIRouteTableUpdate(t, cfg.ControlSocketPath, 3, []sniRoute{
		{SNI: "api.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: apiBackendPort},
		{SNI: "web.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: webBackendPortV2},
	})
	expectTCPClosed(t, webClient)
	expectSNIBackendReply(t, apiClient, []byte("api-after-web-change"), []byte("api-v1:api-after-web-change"))
	webClientV2 := openSniSplitterSession(t, splitterPort, webHello, []byte("web-after-change"), []byte("web-v2:web-after-change"))
	defer webClientV2.Close()

	sendSNIRouteTableUpdate(t, cfg.ControlSocketPath, 4, []sniRoute{
		{SNI: "api.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: apiBackendPort},
	})
	expectTCPClosed(t, webClientV2)
	expectSNIBackendReply(t, apiClient, []byte("api-after-web-delete"), []byte("api-v1:api-after-web-delete"))
	webDenied := dialTestTCP(t, splitterPort)
	defer webDenied.Close()
	if _, err := webDenied.Write(webHello); err != nil {
		t.Fatal(err)
	}
	expectTCPClosed(t, webDenied)

	if err := sendSNIRouteTableUpdateResult(cfg.ControlSocketPath, 5, []sniRoute{
		{SNI: "api.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: 0},
	}); err == nil {
		t.Fatal("invalid sni route table update succeeded")
	}
	expectSNIBackendReply(t, apiClient, []byte("api-after-invalid"), []byte("api-v1:api-after-invalid"))
}

func TestSniSplitterRateLimitAppliesToOnlyTheLimitedRule(t *testing.T) {
	const rateBytesPerSecond = 512 * 1024
	const payloadBytes = 1024 * 1024

	limitedHello := clientHelloWithECHBytes(t, "limited.example.com")
	freeHello := clientHelloWithECHBytes(t, "free.example.com")
	payload := bytes.Repeat([]byte("x"), payloadBytes)

	limitedPort, limitedDrained, stopLimitedBackend := startDrainingTCPBackend(t, len(limitedHello)+payloadBytes, 30*time.Second)
	defer stopLimitedBackend()
	freePort, freeDrained, stopFreeBackend := startDrainingTCPBackend(t, len(freeHello)+payloadBytes, 30*time.Second)
	defer stopFreeBackend()

	splitterPort, stopSplitter := startTestSniSplitter(t, []sniRoute{
		{SNI: "limited.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: limitedPort, LimitIn: rateBytesPerSecond},
		{SNI: "free.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: freePort},
	})
	defer stopSplitter()

	freeElapsed := sniSplitterTransferDuration(t, splitterPort, freeHello, payload, freeDrained)
	limitedElapsed := sniSplitterTransferDuration(t, splitterPort, limitedHello, payload, limitedDrained)

	// The limiter hands out a burst of `rate` bytes before throttling, so the
	// second half of the payload has to wait roughly a second.
	if limitedElapsed < 600*time.Millisecond {
		t.Fatalf("rate limited rule was not throttled: %s", limitedElapsed)
	}
	if freeElapsed > 500*time.Millisecond {
		t.Fatalf("unlimited rule on the same port was throttled: %s", freeElapsed)
	}
	if limitedElapsed < freeElapsed*2 {
		t.Fatalf("limited %s was not meaningfully slower than unlimited %s", limitedElapsed, freeElapsed)
	}
}

func TestSniSplitterConnectionLimitAppliesToOnlyTheLimitedRule(t *testing.T) {
	cappedHello := clientHelloWithECHBytes(t, "capped.example.com")
	freeHello := clientHelloWithECHBytes(t, "free.example.com")
	cappedBackendPort, stopCappedBackend := startPersistentSNIBackend(t, len(cappedHello), "capped")
	defer stopCappedBackend()
	freeBackendPort, stopFreeBackend := startPersistentSNIBackend(t, len(freeHello), "free")
	defer stopFreeBackend()

	splitterPort, stopSplitter := startTestSniSplitter(t, []sniRoute{
		{SNI: "capped.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: cappedBackendPort, MaxConnections: 1},
		{SNI: "free.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: freeBackendPort},
	})
	defer stopSplitter()

	capped := openSniSplitterSession(t, splitterPort, cappedHello, []byte("capped-1"), []byte("capped:capped-1"))
	defer capped.Close()

	overflow := dialTestTCP(t, splitterPort)
	defer overflow.Close()
	if _, err := overflow.Write(cappedHello); err != nil {
		t.Fatal(err)
	}
	expectTCPClosed(t, overflow)

	// The cap belongs to one rule, not to the shared entry port.
	free1 := openSniSplitterSession(t, splitterPort, freeHello, []byte("free-1"), []byte("free:free-1"))
	defer free1.Close()
	free2 := openSniSplitterSession(t, splitterPort, freeHello, []byte("free-2"), []byte("free:free-2"))
	defer free2.Close()

	expectSNIBackendReply(t, capped, []byte("capped-still-alive"), []byte("capped:capped-still-alive"))

	// Releasing the slot lets the capped rule accept a connection again.
	capped.Close()
	var reopened net.Conn
	for attempt := 0; attempt < 20; attempt++ {
		candidate := dialTestTCP(t, splitterPort)
		if _, err := candidate.Write(cappedHello); err != nil {
			_ = candidate.Close()
			t.Fatal(err)
		}
		_ = candidate.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		if _, err := candidate.Write([]byte("capped-2")); err != nil {
			_ = candidate.Close()
			t.Fatal(err)
		}
		want := []byte("capped:capped-2")
		got := make([]byte, len(want))
		if _, err := io.ReadFull(candidate, got); err == nil && bytes.Equal(got, want) {
			_ = candidate.SetReadDeadline(time.Time{})
			reopened = candidate
			break
		}
		_ = candidate.Close()
		time.Sleep(50 * time.Millisecond)
	}
	if reopened == nil {
		t.Fatal("capped rule never accepted a connection after the previous one closed")
	}
	reopened.Close()
}

func TestSniSplitterHotUpdatesLimitsWithoutDisturbingOtherRules(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix control sockets are not available on windows")
	}
	stableHello := clientHelloWithECHBytes(t, "stable.example.com")
	cappedHello := clientHelloWithECHBytes(t, "capped.example.com")
	stableBackendPort, stopStableBackend := startPersistentSNIBackend(t, len(stableHello), "stable")
	defer stopStableBackend()
	cappedBackendPort, stopCappedBackend := startPersistentSNIBackend(t, len(cappedHello), "capped")
	defer stopCappedBackend()

	stableRoute := sniRoute{SNI: "stable.example.com", RuleID: 101, TargetIP: "127.0.0.1", TargetPort: stableBackendPort}
	cfg := normalizeConfig(config{
		Role:              "sni-splitter",
		ListenPort:        freeTCPPort(t),
		Protocol:          "tcp",
		SNIRouteVersion:   1,
		ControlSocketPath: testUnixSocketPath(t),
		SNIRoutes: []sniRoute{
			stableRoute,
			{SNI: "capped.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: cappedBackendPort},
		},
	})
	splitterPort, stopSplitter := startTestSniSplitterWithConfig(t, cfg)
	defer stopSplitter()

	stable := openSniSplitterSession(t, splitterPort, stableHello, []byte("stable-before"), []byte("stable:stable-before"))
	defer stable.Close()
	uncapped := openSniSplitterSession(t, splitterPort, cappedHello, []byte("capped-before"), []byte("capped:capped-before"))
	defer uncapped.Close()

	sendSNIRouteTableUpdate(t, cfg.ControlSocketPath, 2, []sniRoute{
		stableRoute,
		{SNI: "capped.example.com", RuleID: 202, TargetIP: "127.0.0.1", TargetPort: cappedBackendPort, MaxConnections: 1, LimitIn: 4 * 1024 * 1024},
	})

	// Changing a rule's limits drops that rule's own connections, and nothing
	// else: the splitter is never restarted.
	expectTCPClosed(t, uncapped)
	expectSNIBackendReply(t, stable, []byte("stable-after"), []byte("stable:stable-after"))

	capped := openSniSplitterSession(t, splitterPort, cappedHello, []byte("capped-after"), []byte("capped:capped-after"))
	defer capped.Close()
	overflow := dialTestTCP(t, splitterPort)
	defer overflow.Close()
	if _, err := overflow.Write(cappedHello); err != nil {
		t.Fatal(err)
	}
	expectTCPClosed(t, overflow)

	expectSNIBackendReply(t, stable, []byte("stable-still-alive"), []byte("stable:stable-still-alive"))
}

func TestSniSplitterConfigValidation(t *testing.T) {
	cfg := normalizeConfig(config{
		Role:            " SNI-SPLITTER ",
		ListenPort:      18443,
		Protocol:        " TCP ",
		SNIRouteVersion: 1,
		SourceAllowIPs:  []string{" 198.51.100.10 ", "[2001:db8::10]", "bad", "198.51.100.10"},
		SNIRoutes: []sniRoute{{
			SNI:        " API.EXAMPLE.COM. ",
			RuleID:     42,
			TargetIP:   " 127.0.0.1 ",
			TargetPort: 443,
		}},
	})
	if cfg.Role != "sni-splitter" || cfg.Protocol != "tcp" || len(cfg.SNIRoutes) != 1 {
		t.Fatalf("sni-splitter config was not normalized: %+v", cfg)
	}
	if route := cfg.SNIRoutes[0]; route.SNI != "api.example.com" || route.TargetIP != "127.0.0.1" {
		t.Fatalf("sni route was not normalized: %+v", route)
	}
	wantSourceAllowIPs := []string{"198.51.100.10", "2001:db8::10"}
	if len(cfg.SourceAllowIPs) != len(wantSourceAllowIPs) {
		t.Fatalf("source allow IPs = %+v, want %+v", cfg.SourceAllowIPs, wantSourceAllowIPs)
	}
	for i := range wantSourceAllowIPs {
		if cfg.SourceAllowIPs[i] != wantSourceAllowIPs[i] {
			t.Fatalf("source allow IPs = %+v, want %+v", cfg.SourceAllowIPs, wantSourceAllowIPs)
		}
	}
	if err := validateConfig(cfg); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		cfg     config
		wantErr string
	}{
		{
			name:    "no routes",
			cfg:     normalizeConfig(config{Role: "sni-splitter", ListenPort: 18443, Protocol: "tcp", SNIRouteVersion: 1}),
			wantErr: "requires at least one route",
		},
		{
			name: "missing version",
			cfg: normalizeConfig(config{
				Role:       "sni-splitter",
				ListenPort: 18443,
				Protocol:   "tcp",
				SNIRoutes:  []sniRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: 443}},
			}),
			wantErr: "route table version required",
		},
		{
			name: "udp protocol",
			cfg: normalizeConfig(config{
				Role:            "sni-splitter",
				ListenPort:      18443,
				Protocol:        "udp",
				SNIRouteVersion: 1,
				SNIRoutes:       []sniRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: 443}},
			}),
			wantErr: "requires tcp protocol",
		},
		{
			name: "bad route",
			cfg: normalizeConfig(config{
				Role:            "sni-splitter",
				ListenPort:      18443,
				Protocol:        "tcp",
				SNIRouteVersion: 1,
				SNIRoutes:       []sniRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "", TargetPort: 443}},
			}),
			wantErr: "route 0 requires target host and port",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateConfig(tt.cfg)
			if err == nil || !bytes.Contains([]byte(err.Error()), []byte(tt.wantErr)) {
				t.Fatalf("validation error = %v, want substring %q", err, tt.wantErr)
			}
		})
	}
}

func testUnixSocketPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join("/tmp", fmt.Sprintf("forwardx-sni-%d-%d.sock", os.Getpid(), time.Now().UnixNano()))
	t.Cleanup(func() { _ = os.Remove(path) })
	return path
}

func startTestSniSplitter(t *testing.T, routes []sniRoute) (int, func()) {
	t.Helper()
	cfg := normalizeConfig(config{
		Role:            "sni-splitter",
		ListenPort:      freeTCPPort(t),
		Protocol:        "tcp",
		SNIRouteVersion: 1,
		SNIRoutes:       routes,
	})
	return startTestSniSplitterWithConfig(t, cfg)
}

func startTestSniSplitterWithConfig(t *testing.T, cfg config) (int, func()) {
	t.Helper()
	port := cfg.ListenPort
	done := make(chan struct{})
	errCh := make(chan error, 1)
	go func() {
		errCh <- runSniSplitter(done, cfg)
	}()
	waitForTCPPort(t, port)
	return port, func() {
		close(done)
		select {
		case err := <-errCh:
			if err != nil && !errors.Is(err, net.ErrClosed) {
				t.Fatalf("sni splitter stopped with error: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("sni splitter did not stop")
		}
	}
}

func sendSNIRouteTableUpdate(t *testing.T, socketPath string, version int64, routes []sniRoute) {
	t.Helper()
	if err := sendSNIRouteTableUpdateResult(socketPath, version, routes); err != nil {
		t.Fatal(err)
	}
}

func sendSNIRouteTableUpdateResult(socketPath string, version int64, routes []sniRoute) error {
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if err := json.NewEncoder(conn).Encode(map[string]any{
		"version":   version,
		"sniRoutes": routes,
	}); err != nil {
		return err
	}
	var response struct {
		OK      bool   `json:"ok"`
		Version int64  `json:"version"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		return err
	}
	if !response.OK {
		return errors.New(response.Error)
	}
	return nil
}

func getSNIRouteTableStatus(t *testing.T, socketPath string) sniRouteTableControlResponse {
	t.Helper()
	response, err := readSNIRouteTableStatus(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func readSNIRouteTableStatus(socketPath string) (sniRouteTableControlResponse, error) {
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		return sniRouteTableControlResponse{}, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if err := json.NewEncoder(conn).Encode(map[string]string{"operation": "status"}); err != nil {
		return sniRouteTableControlResponse{}, err
	}
	var response sniRouteTableControlResponse
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		return sniRouteTableControlResponse{}, err
	}
	if !response.OK {
		return sniRouteTableControlResponse{}, fmt.Errorf("sni route table status failed: %s", response.Error)
	}
	return response, nil
}

func waitForSNIUnmatchedConnections(t *testing.T, socketPath string, want uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, err := readSNIRouteTableStatus(socketPath)
		if err == nil && status.UnmatchedConnections == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	status := getSNIRouteTableStatus(t, socketPath)
	t.Fatalf("unmatched connections = %d, want %d", status.UnmatchedConnections, want)
}

func startPersistentSNIBackend(t *testing.T, helloLen int, label string) (int, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var conns sync.Map
	errCh := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				if !errors.Is(err, net.ErrClosed) {
					select {
					case errCh <- err:
					default:
					}
				}
				return
			}
			conns.Store(conn, struct{}{})
			wg.Add(1)
			go func(conn net.Conn) {
				defer wg.Done()
				defer conns.Delete(conn)
				defer conn.Close()
				_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
				hello := make([]byte, helloLen)
				if _, err := io.ReadFull(conn, hello); err != nil {
					select {
					case errCh <- err:
					default:
					}
					return
				}
				_ = conn.SetReadDeadline(time.Time{})
				buf := make([]byte, 1024)
				for {
					n, err := conn.Read(buf)
					if err != nil {
						if !isClosedErr(err) {
							select {
							case errCh <- err:
							default:
							}
						}
						return
					}
					reply := append([]byte(label+":"), buf[:n]...)
					_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
					if _, err := conn.Write(reply); err != nil {
						if !isClosedErr(err) {
							select {
							case errCh <- err:
							default:
							}
						}
						return
					}
				}
			}(conn)
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	return port, func() {
		_ = ln.Close()
		conns.Range(func(key, _ any) bool {
			if conn, ok := key.(net.Conn); ok {
				_ = conn.Close()
			}
			return true
		})
		done := make(chan struct{})
		go func() {
			wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("persistent backend did not stop")
		}
		select {
		case err := <-errCh:
			if err != nil && !isClosedErr(err) {
				t.Fatalf("persistent backend error: %v", err)
			}
		default:
		}
	}
}

func openSniSplitterSession(t *testing.T, port int, hello, payload, response []byte) net.Conn {
	t.Helper()
	client := dialTestTCP(t, port)
	if _, err := client.Write(hello); err != nil {
		_ = client.Close()
		t.Fatal(err)
	}
	expectSNIBackendReply(t, client, payload, response)
	return client
}

func expectSNIBackendReply(t *testing.T, conn net.Conn, payload, response []byte) {
	t.Helper()
	if _, err := conn.Write(payload); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	got := make([]byte, len(response))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, response) {
		t.Fatalf("sni backend reply = %q, want %q", got, response)
	}
	_ = conn.SetReadDeadline(time.Time{})
}

func startReplyingTCPBackend(t *testing.T, wantBytes int, response []byte) (int, <-chan []byte, func()) {
	t.Helper()
	return startTCPBackend(t, wantBytes, response)
}

func exchangeThroughSniSplitter(t *testing.T, port int, hello, payload, response []byte) {
	t.Helper()
	client := dialTestTCP(t, port)
	defer client.Close()
	data := append(append([]byte(nil), hello...), payload...)
	if _, err := client.Write(data); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	got := make([]byte, len(response))
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, response) {
		t.Fatalf("splitter response = %q, want %q", got, response)
	}
}

func startRecordingTCPBackend(t *testing.T, wantBytes int) (int, <-chan []byte, func()) {
	t.Helper()
	return startTCPBackend(t, wantBytes, nil)
}

func startTCPBackend(t *testing.T, wantBytes int, response []byte) (int, <-chan []byte, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- err
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, wantBytes)
		_, err = io.ReadFull(conn, buf)
		if err != nil {
			errCh <- err
			return
		}
		received <- buf
		if response != nil {
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if _, err := conn.Write(response); err != nil {
				errCh <- err
				return
			}
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	return port, received, func() {
		_ = ln.Close()
		select {
		case err := <-errCh:
			if err != nil && !errors.Is(err, net.ErrClosed) {
				t.Fatalf("backend error: %v", err)
			}
		default:
		}
	}
}

func clientHelloBytes(t *testing.T, serverName string) []byte {
	t.Helper()
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()
	errCh := make(chan error, 1)
	go func() {
		client := tls.Client(clientConn, &tls.Config{
			ServerName:         serverName,
			InsecureSkipVerify: true,
		})
		errCh <- client.Handshake()
		_ = client.Close()
	}()
	_ = serverConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	header := make([]byte, 5)
	if _, err := io.ReadFull(serverConn, header); err != nil {
		t.Fatal(err)
	}
	recordLen := int(binary.BigEndian.Uint16(header[3:5]))
	body := make([]byte, recordLen)
	if _, err := io.ReadFull(serverConn, body); err != nil {
		t.Fatal(err)
	}
	_ = serverConn.Close()
	select {
	case <-errCh:
	case <-time.After(2 * time.Second):
		t.Fatal("TLS client did not stop after ClientHello capture")
	}
	return append(header, body...)
}

func clientHelloWithECHBytes(t *testing.T, serverName string) []byte {
	t.Helper()
	return appendTLSClientHelloExtension(t, clientHelloBytes(t, serverName), 0xfe0d, []byte{0x9d, 0x2f, 0x81, 0x44})
}

func appendTLSClientHelloExtension(t *testing.T, hello []byte, extType uint16, data []byte) []byte {
	t.Helper()
	return insertTLSClientHelloExtension(t, hello, extType, data, tlsExtensionLast)
}

type tlsExtensionPosition int

const (
	tlsExtensionFirst tlsExtensionPosition = iota
	tlsExtensionMiddle
	tlsExtensionLast
)

func insertTLSClientHelloExtension(t *testing.T, hello []byte, extType uint16, data []byte, position tlsExtensionPosition) []byte {
	t.Helper()
	out := append([]byte(nil), hello...)
	extLenPos, extEnd, ok := tlsClientHelloExtensionsRange(out)
	if !ok {
		t.Fatal("ClientHello extension block not found")
	}
	extStart := extLenPos + 2
	extensionOffsets := []int{extStart}
	for offset := extStart; offset < extEnd; {
		if offset+4 > extEnd {
			t.Fatal("truncated ClientHello extension header")
		}
		extensionLen := int(binary.BigEndian.Uint16(out[offset+2 : offset+4]))
		offset += 4 + extensionLen
		if offset > extEnd {
			t.Fatal("truncated ClientHello extension payload")
		}
		extensionOffsets = append(extensionOffsets, offset)
	}
	insertAt := extEnd
	switch position {
	case tlsExtensionFirst:
		insertAt = extensionOffsets[0]
	case tlsExtensionMiddle:
		insertAt = extensionOffsets[len(extensionOffsets)/2]
	case tlsExtensionLast:
		insertAt = extensionOffsets[len(extensionOffsets)-1]
	default:
		t.Fatalf("unknown TLS extension position %d", position)
	}
	extension := make([]byte, 4+len(data))
	binary.BigEndian.PutUint16(extension[0:2], extType)
	binary.BigEndian.PutUint16(extension[2:4], uint16(len(data)))
	copy(extension[4:], data)
	out = append(out[:insertAt], append(extension, out[insertAt:]...)...)
	extLen := int(binary.BigEndian.Uint16(out[extLenPos:extLenPos+2])) + len(extension)
	if extLen > 0xffff {
		t.Fatal("extension block too large")
	}
	binary.BigEndian.PutUint16(out[extLenPos:extLenPos+2], uint16(extLen))
	setTLSHandshakeLengths(t, out, len(extension))
	return out
}

func withBadTLSExtensionsLength(t *testing.T, hello []byte, length uint16) []byte {
	t.Helper()
	out := append([]byte(nil), hello...)
	extLenPos, _, ok := tlsClientHelloExtensionsRange(out)
	if !ok {
		t.Fatal("ClientHello extension block not found")
	}
	binary.BigEndian.PutUint16(out[extLenPos:extLenPos+2], length)
	return out
}

func tlsClientHelloExtensionsRange(data []byte) (int, int, bool) {
	if len(data) < 9 || data[0] != 0x16 || data[5] != 0x01 {
		return 0, 0, false
	}
	recordEnd := 5 + int(binary.BigEndian.Uint16(data[3:5]))
	if recordEnd > len(data) {
		return 0, 0, false
	}
	handshakeEnd := 9 + tlsUint24(data[6:9])
	if handshakeEnd > recordEnd {
		return 0, 0, false
	}
	pos := 9 + 2 + 32
	if pos >= handshakeEnd {
		return 0, 0, false
	}
	sessionLen := int(data[pos])
	pos += 1 + sessionLen
	if pos+2 > handshakeEnd {
		return 0, 0, false
	}
	cipherLen := int(binary.BigEndian.Uint16(data[pos : pos+2]))
	pos += 2 + cipherLen
	if pos >= handshakeEnd {
		return 0, 0, false
	}
	compressionLen := int(data[pos])
	pos += 1 + compressionLen
	if pos+2 > handshakeEnd {
		return 0, 0, false
	}
	extLen := int(binary.BigEndian.Uint16(data[pos : pos+2]))
	extStart := pos + 2
	extEnd := extStart + extLen
	if extEnd > handshakeEnd {
		return 0, 0, false
	}
	return pos, extEnd, true
}

func setTLSHandshakeLengths(t *testing.T, data []byte, delta int) {
	t.Helper()
	if len(data) < 9 {
		t.Fatal("TLS record too short")
	}
	recordLen := int(binary.BigEndian.Uint16(data[3:5])) + delta
	handshakeLen := tlsUint24(data[6:9]) + delta
	if recordLen > 0xffff || handshakeLen > 0xffffff {
		t.Fatal("TLS ClientHello too large")
	}
	binary.BigEndian.PutUint16(data[3:5], uint16(recordLen))
	data[6] = byte(handshakeLen >> 16)
	data[7] = byte(handshakeLen >> 8)
	data[8] = byte(handshakeLen)
}

func waitForTCPPort(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 50*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("tcp port %d did not open", port)
}

func dialTestTCP(t *testing.T, port int) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func receiveBytes(t *testing.T, received <-chan []byte) []byte {
	t.Helper()
	select {
	case got := <-received:
		return got
	case <-time.After(2 * time.Second):
		t.Fatal("backend did not receive payload")
	}
	return nil
}

func expectTCPClosed(t *testing.T, conn net.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 1)
	n, err := conn.Read(buf)
	if n > 0 || err == nil {
		t.Fatalf("connection stayed open: n=%d err=%v", n, err)
	}
}

// startDrainingTCPBackend reads wantBytes and reports how long that took. The
// shared startTCPBackend helper caps reads at two seconds, which a deliberately
// rate limited transfer is meant to exceed.
func startDrainingTCPBackend(t *testing.T, wantBytes int, timeout time.Duration) (int, <-chan error, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	drained := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			drained <- err
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
		if _, err := io.CopyN(io.Discard, conn, int64(wantBytes)); err != nil {
			drained <- err
			return
		}
		drained <- nil
	}()
	return ln.Addr().(*net.TCPAddr).Port, drained, func() { _ = ln.Close() }
}

// sniSplitterTransferDuration measures how long the splitter takes to hand a
// full payload to the landing server, which is what a per-rule rate limit is
// supposed to stretch.
func sniSplitterTransferDuration(t *testing.T, port int, hello, payload []byte, drained <-chan error) time.Duration {
	t.Helper()
	client := dialTestTCP(t, port)
	defer client.Close()
	started := time.Now()
	writeErr := make(chan error, 1)
	go func() {
		if _, err := client.Write(hello); err != nil {
			writeErr <- err
			return
		}
		_, err := client.Write(payload)
		writeErr <- err
	}()
	select {
	case err := <-drained:
		if err != nil {
			t.Fatalf("landing server did not receive the payload: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("landing server did not receive the payload in time")
	}
	elapsed := time.Since(started)
	select {
	case err := <-writeErr:
		if err != nil {
			t.Fatalf("client write failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("client write did not finish")
	}
	return elapsed
}
