package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func serviceScheduleTasks(probes []hostProbeServiceProbe) []tcpingTask {
	tasks := make([]tcpingTask, 0, len(probes))
	for _, probe := range probes {
		tasks = append(tasks, tcpingTask{Kind: "service", ServiceID: probe.ServiceID})
	}
	return tasks
}

func TestServiceProbeCollectionBoundsRealConcurrentRequests(t *testing.T) {
	for _, pending := range []int64{0, 100} {
		name, limit := "idle", int32(32)
		if pending > 0 {
			name, limit = "runtime-actions-pending", 4
		}
		t.Run(name, func(t *testing.T) {
			previous := atomic.SwapInt64(&actionPendingCount, pending)
			defer atomic.StoreInt64(&actionPendingCount, previous)
			var active, peak, requests atomic.Int32
			entered := make(chan struct{}, 80)
			release := make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := active.Add(1)
				defer active.Add(-1)
				for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
				}
				requests.Add(1)
				entered <- struct{}{}
				<-release
				w.WriteHeader(http.StatusOK)
			}))
			defer func() { unblock(); service.Close() }()
			tasks := make([]tcpingTask, 80)
			for index := range tasks {
				tasks[index] = tcpingTask{Kind: "service", ServiceID: index + 1, Method: "url", TargetURL: service.URL, TimeoutSeconds: 5, ExpectedStatus: 200}
			}
			done := make(chan []map[string]any, 1)
			go func() {
				_, _, _, results := runTCPingTasks(tasks)
				done <- results
			}()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("service requests did not start")
			}
			// Hold real HTTP responses long enough for a burst to reach its
			// concurrency budget; subsequent requests must wait for workers.
			timer := time.NewTimer(150 * time.Millisecond)
			<-timer.C
			unblock()
			select {
			case results := <-done:
				if len(results) != 80 || requests.Load() != 80 || peak.Load() > limit {
					t.Fatalf("results=%d requests=%d peak=%d limit=%d", len(results), requests.Load(), peak.Load(), limit)
				}
				for _, result := range results {
					if result["isTimeout"] != false {
						t.Fatalf("bounded service request failed: %+v", result)
					}
				}
			case <-time.After(10 * time.Second):
				t.Fatal("bounded service requests did not drain")
			}
		})
	}
}

func TestServiceProbeScheduleKeepsIndependentIntervals(t *testing.T) {
	var schedule serviceProbeSchedule
	now := time.Unix(1000, 0)
	probes := []hostProbeServiceProbe{
		{ServiceID: 1, TargetIP: "example.test", TargetPort: 80, IntervalSeconds: 5},
		{ServiceID: 2, TargetIP: "example.test", TargetPort: 443, IntervalSeconds: 300},
	}
	tasks := serviceScheduleTasks(probes)
	if got := schedule.selectTasks(tasks, probes, 96, false, now); len(got) != 2 {
		t.Fatalf("first run selected %d services, want 2", len(got))
	}
	for elapsed := 5; elapsed < 300; elapsed += 5 {
		got := schedule.selectTasks(tasks, probes, 96, false, now.Add(time.Duration(elapsed)*time.Second))
		if len(got) != 1 || got[0].ServiceID != 1 {
			t.Fatalf("at %ds slower service ran early: %+v", elapsed, got)
		}
	}
	if got := schedule.selectTasks(tasks, probes, 96, false, now.Add(300*time.Second)); len(got) != 2 {
		t.Fatalf("at 300s selected %d services, want 2", len(got))
	}
}

func TestServiceProbeScheduleDueBoundaryAndForce(t *testing.T) {
	var schedule serviceProbeSchedule
	now := time.Unix(1000, 0)
	probes := []hostProbeServiceProbe{{ServiceID: 1, TargetIP: "example.test", Method: "ping", IntervalSeconds: 30}}
	tasks := serviceScheduleTasks(probes)
	schedule.selectTasks(tasks, probes, 96, false, now)
	if schedule.due(probes, now.Add(29*time.Second)) || !schedule.due(probes, now.Add(30*time.Second)) {
		t.Fatal("service deadline must be independent of the global jittered interval")
	}
	if got := schedule.selectTasks(tasks, probes, 96, false, now.Add(time.Second)); len(got) != 0 {
		t.Fatal("service ran before its own interval")
	}
	if got := schedule.selectTasks(tasks, probes, 96, true, now.Add(time.Second)); len(got) != 1 {
		t.Fatal("manual force must bypass the service interval")
	}
	if schedule.due(probes, now.Add(30*time.Second)) || !schedule.due(probes, now.Add(31*time.Second)) {
		t.Fatal("manual execution must update the service deadline")
	}
}

func TestServiceProbeScheduleOnlyMarksSelectedAndPrunesRemoved(t *testing.T) {
	var schedule serviceProbeSchedule
	now := time.Unix(1000, 0)
	probes := []hostProbeServiceProbe{
		{ServiceID: 1, TargetIP: "example.test", Method: "ping", IntervalSeconds: 300},
		{ServiceID: 2, TargetIP: "example.test", Method: "ping", IntervalSeconds: 300},
	}
	tasks := serviceScheduleTasks(probes)
	first := schedule.selectTasks(tasks, probes, 1, false, now)
	if len(first) != 1 || !schedule.due(probes, now.Add(time.Second)) {
		t.Fatal("unselected service must remain due after a capped batch")
	}
	second := schedule.selectTasks(tasks, probes, 1, false, now.Add(time.Second))
	if len(second) != 1 || first[0].ServiceID == second[0].ServiceID {
		t.Fatal("capped batches did not select the waiting service")
	}
	probes[0].TargetIP = "changed.test"
	if !schedule.due(probes, now.Add(2*time.Second)) {
		t.Fatal("changed service configuration must be immediately due")
	}
	if got := schedule.selectTasks(tasks, probes, 96, false, now.Add(2*time.Second)); len(got) != 1 || got[0].ServiceID != 1 {
		t.Fatalf("configuration change selected unexpected services: %+v", got)
	}
	schedule.selectTasks(nil, nil, 96, false, now.Add(3*time.Second))
	if len(schedule.last) != 0 {
		t.Fatal("removed services left scheduling records behind")
	}
	if !schedule.due(probes, now.Add(4*time.Second)) {
		t.Fatal("re-added service must run immediately")
	}
}

func TestServiceProbeScheduleNormalizesIntervalsAndIgnoresInvalid(t *testing.T) {
	for seconds, want := range map[int]time.Duration{-1: 30 * time.Second, 0: 30 * time.Second, 1: 5 * time.Second, 5: 5 * time.Second, 300: 300 * time.Second} {
		if got := serviceProbeInterval(hostProbeServiceProbe{IntervalSeconds: seconds}); got != want {
			t.Fatalf("interval %d = %s, want %s", seconds, got, want)
		}
	}
	var schedule serviceProbeSchedule
	invalid := []hostProbeServiceProbe{{ServiceID: 1}, {TargetIP: "example.test", TargetPort: 443}, {ServiceID: 2, TargetIP: "example.test"}}
	if schedule.due(invalid, time.Now()) {
		t.Fatal("invalid probes must not keep the scheduler hot")
	}
}

func TestServiceOnlyCollectionDoesNotRunRuntimeProbes(t *testing.T) {
	previousPending := atomic.SwapInt64(&actionPendingCount, 1)
	t.Cleanup(func() { atomic.StoreInt64(&actionPendingCount, previousPending) })
	if !scheduleTCPingCollectionMode(Config{},
		[]ruleLatencyProbe{{RuleID: 1}}, []tunnelProbe{{TunnelID: 1}}, []forwardGroupProbe{{GroupID: 1}},
		nil, false, true) {
		t.Fatal("service-only cycle retained runtime probes and was deferred by pending actions")
	}
	deadline := time.Now().Add(time.Second)
	for atomic.LoadInt32(&tcpingCollectRunning) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("service-only cycle did not finish without probing runtime targets")
		}
		time.Sleep(time.Millisecond)
	}
}
