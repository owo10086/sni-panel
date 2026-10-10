package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestFullHeartbeatPreservesRuntimeIdentityInBothReportFormats(t *testing.T) {
	resetAgentStressState()
	oldCompact := compactAgentReports.Load()
	received, applied, receivedHash, appliedHash := desiredRevisionSnapshot()
	t.Cleanup(func() {
		compactAgentReports.Store(oldCompact)
		desiredRevisionMu.Lock()
		desiredLastReceivedRevision, desiredLastAppliedRevision = received, applied
		desiredLastReceivedHash, desiredLastAppliedHash = receivedHash, appliedHash
		desiredRevisionMu.Unlock()
	})
	desiredRevisionMu.Lock()
	desiredLastReceivedRevision, desiredLastAppliedRevision = 71, 70
	desiredLastReceivedHash, desiredLastAppliedHash = "pending-plan", "running-plan"
	desiredRevisionMu.Unlock()

	for _, compact := range []bool{false, true} {
		name := "ordinary"
		if compact {
			name = "compact"
		}
		t.Run(name, func(t *testing.T) {
			compactAgentReports.Store(compact)
			const token = "isolated-heartbeat-token"
			captured := make(chan map[string]any, 1)
			panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request envelope
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Errorf("decode envelope: %v", err)
					http.Error(w, "bad request", http.StatusBadRequest)
					return
				}
				plain, err := decrypt(request, token)
				if err != nil {
					t.Errorf("decrypt request: %v", err)
					http.Error(w, "bad request", http.StatusBadRequest)
					return
				}
				var body struct {
					Path    string         `json:"path"`
					Payload map[string]any `json:"payload"`
				}
				if err := json.Unmarshal(plain, &body); err != nil || body.Path != "/api/agent/heartbeat" {
					t.Errorf("unexpected heartbeat request: %s, %v", body.Path, err)
					http.Error(w, "bad request", http.StatusBadRequest)
					return
				}
				captured <- body.Payload
				response, err := encrypt(heartbeatResp{NextInterval: 1, RequestLocalState: true, CompactReports: compact}, token)
				if err != nil {
					t.Errorf("encrypt response: %v", err)
					http.Error(w, "response failed", http.StatusInternalServerError)
					return
				}
				_ = json.NewEncoder(w).Encode(response)
			}))
			defer panel.Close()
			if _, err := heartbeat(Config{PanelURL: panel.URL, Token: token, Interval: 1}); err != nil {
				t.Fatal(err)
			}
			payload := <-captured
			for field, want := range map[string]any{
				"agentLastReceivedRevision": float64(71), "agentLastAppliedRevision": float64(70),
				"agentLastReceivedHash": "pending-plan", "agentLastAppliedHash": "running-plan",
				"agentBootId": agentBootID, "agentProcessId": float64(os.Getpid()),
			} {
				if got := payload[field]; got != want {
					t.Errorf("%s = %v, want %v", field, got, want)
				}
			}
		})
	}
}
