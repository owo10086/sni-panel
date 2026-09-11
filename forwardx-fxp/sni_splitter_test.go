package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
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
		{name: "ech extension", payload: appendTLSClientHelloExtension(t, hello, 0xfe0d, []byte{0x00})},
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

func TestSniSplitterConfigValidation(t *testing.T) {
	cfg := normalizeConfig(config{
		Role:       " SNI-SPLITTER ",
		ListenPort: 18443,
		Protocol:   " TCP ",
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
			cfg:     normalizeConfig(config{Role: "sni-splitter", ListenPort: 18443, Protocol: "tcp"}),
			wantErr: "requires at least one route",
		},
		{
			name: "udp protocol",
			cfg: normalizeConfig(config{
				Role:       "sni-splitter",
				ListenPort: 18443,
				Protocol:   "udp",
				SNIRoutes:  []sniRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: 443}},
			}),
			wantErr: "requires tcp protocol",
		},
		{
			name: "bad route",
			cfg: normalizeConfig(config{
				Role:       "sni-splitter",
				ListenPort: 18443,
				Protocol:   "tcp",
				SNIRoutes:  []sniRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "", TargetPort: 443}},
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

func startTestSniSplitter(t *testing.T, routes []sniRoute) (int, func()) {
	t.Helper()
	port := freeTCPPort(t)
	done := make(chan struct{})
	errCh := make(chan error, 1)
	cfg := normalizeConfig(config{
		Role:       "sni-splitter",
		ListenPort: port,
		Protocol:   "tcp",
		SNIRoutes:  routes,
	})
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

func startRecordingTCPBackend(t *testing.T, wantBytes int) (int, <-chan []byte, func()) {
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

func appendTLSClientHelloExtension(t *testing.T, hello []byte, extType uint16, data []byte) []byte {
	t.Helper()
	out := append([]byte(nil), hello...)
	extLenPos, extEnd, ok := tlsClientHelloExtensionsRange(out)
	if !ok {
		t.Fatal("ClientHello extension block not found")
	}
	extension := make([]byte, 4+len(data))
	binary.BigEndian.PutUint16(extension[0:2], extType)
	binary.BigEndian.PutUint16(extension[2:4], uint16(len(data)))
	copy(extension[4:], data)
	out = append(out[:extEnd], append(extension, out[extEnd:]...)...)
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
