package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestRunWaitFullDaemonReportsDecisionWithoutClaiming(t *testing.T) {
	observed := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		select {
		case observed <- body:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tasks":[]}`))
	}))
	defer srv.Close()
	d := New(Config{ServerBaseURL: srv.URL, DaemonID: "wait-test", MaxConcurrentTasks: 2, PollInterval: time.Second}, slog.New(slog.NewTextHandler(noopWriter{}, nil)))
	d.workspaces["workspace"] = &workspaceState{workspaceID: "workspace", runtimeIDs: []string{"runtime"}}
	d.taskSlotWait = time.Millisecond
	sem := newTaskSlotSemaphore(2)
	<-sem
	<-sem
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); d.runBatchPoller(ctx, ctx, sem, make(chan struct{}, 1), &sync.WaitGroup{}) }()
	select {
	case body := <-observed:
		if body["max_tasks"] != float64(0) || body["daemon_id"] != "wait-test" {
			t.Fatalf("unexpected claim: %+v", body)
		}
		cap := body["capacity"].(map[string]any)
		if cap["occupied"] != float64(2) || cap["limit"] != float64(2) || cap["blocked"] != true {
			t.Fatalf("capacity: %+v", cap)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("full daemon did not report its wait decision")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("poller did not exit")
	}
}
