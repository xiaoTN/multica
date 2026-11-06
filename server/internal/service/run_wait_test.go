package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestRunWaitAdmissionAndLifecycle(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		cap        int
		runtimeCap bool
	}{
		{"agent cap", "agent_concurrency", 1, false},
		{"runtime cap", "runtime_concurrency", 5, true},
		{"issue serialization", "previous_run", 5, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newClaimDecisionFixture(t, tc.cap)
			activeID := ""
			if tc.runtimeCap {
				other := f.fx.Agent(t, "Other runtime agent", util.UUIDToString(f.runtimeID))
				activeID = f.fx.Task(t, other, testutil.Cols{"runtime_id": f.runtimeID, "issue_id": f.issueID, "status": "running"})
			} else {
				activeID = f.insertTask(t, "running")
			}
			queuedID := f.insertTask(t, "queued")
			if tc.runtimeCap {
				f.fx.Exec(t, "UPDATE agent_runtime SET max_concurrent_tasks=1 WHERE id=$1", f.runtimeID)
			}
			task, err := f.svc.ClaimTask(context.Background(), f.agentID)
			if err != nil || task != nil {
				t.Fatalf("claim blocked: %v, %v", task, err)
			}
			row, err := f.svc.Queries.GetAgentTask(context.Background(), util.MustParseUUID(queuedID))
			if err != nil {
				t.Fatal(err)
			}
			diagnostic := RunWaitForTask(row)
			if diagnostic.Code != tc.code || diagnostic.Since.IsZero() || diagnostic.EvaluatedAt.IsZero() {
				t.Fatalf("diagnostic: %+v", diagnostic)
			}
			if tc.code == "previous_run" && diagnostic.BlockingTaskID != activeID {
				t.Fatalf("blocker=%s want %s", diagnostic.BlockingTaskID, activeID)
			}
			if tc.code != "previous_run" && (diagnostic.Occupied == nil || *diagnostic.Occupied != 1 || diagnostic.Limit == nil || *diagnostic.Limit != 1) {
				t.Fatalf("capacity: %+v", diagnostic)
			}
			history := string(row.WaitHistory)
			f.svc.observeAgentRunWaits(context.Background(), f.agentID)
			same, _ := f.svc.Queries.GetAgentTask(context.Background(), row.ID)
			if string(same.WaitHistory) != history {
				t.Fatal("unchanged poll appended history")
			}
			f.fx.Exec(t, "UPDATE agent_task_queue SET status='completed', completed_at=now() WHERE id=$1", activeID)
			task, err = f.svc.ClaimTask(context.Background(), f.agentID)
			if err != nil || task == nil {
				t.Fatalf("claim after release: %v, %v", task, err)
			}
			if got := RunWaitForTask(*task); got.Code != "awaiting_daemon" {
				t.Fatalf("old wait remained after claim: %+v", got)
			}
			prepared, err := f.svc.SetRunPreparation(context.Background(), *task, "preparing_session")
			if err != nil || RunWaitForTask(prepared).Code != "preparing_session" {
				t.Fatalf("preparation: %+v, %v", prepared, err)
			}
			f.fx.Exec(t, "UPDATE agent_task_queue SET status='running', started_at=now() WHERE id=$1", row.ID)
			started, _ := f.svc.Queries.GetAgentTask(context.Background(), row.ID)
			if RunWaitForTask(started) != nil || len(started.WaitDiagnostic) != 0 {
				t.Fatal("wait remained after start")
			}
			var entries []any
			if err := json.Unmarshal(started.WaitHistory, &entries); err != nil || len(entries) < 4 {
				t.Fatalf("history: %s, %v", started.WaitHistory, err)
			}
		})
	}
}

func TestRunWaitOfflineMachineCapacityAndCancellation(t *testing.T) {
	f := newClaimDecisionFixture(t, 5)
	taskID := f.insertTask(t, "queued")
	row, _ := f.svc.Queries.GetAgentTask(context.Background(), util.MustParseUUID(taskID))
	if got := RunWaitForTask(row); got.Code != "unknown" {
		t.Fatalf("unreported: %+v", got)
	}
	f.fx.Exec(t, "UPDATE agent_runtime SET status='offline' WHERE id=$1", f.runtimeID)
	rows := f.svc.RefreshRunWaits(context.Background(), []db.AgentTaskQueue{row})
	if got := RunWaitForTask(rows[0]); got.Code != "runtime_offline" {
		t.Fatalf("offline: %+v", got)
	}
	f.fx.Exec(t, `UPDATE agent_runtime SET status='online',last_seen_at=now(),daemon_capacity=jsonb_build_object('blocked',true,'occupied',8,'limit',8,'evaluated_at',now()) WHERE id=$1`, f.runtimeID)
	rows = f.svc.RefreshRunWaits(context.Background(), rows)
	if got := RunWaitForTask(rows[0]); got.Code != "daemon_capacity" || *got.Occupied != 8 || *got.Limit != 8 {
		t.Fatalf("daemon: %+v", got)
	}
	before := RunWaitForTask(rows[0])
	history := string(rows[0].WaitHistory)
	f.fx.Exec(t, `UPDATE agent_runtime SET daemon_capacity=daemon_capacity || '{"occupied":9}' WHERE id=$1`, f.runtimeID)
	rows = f.svc.RefreshRunWaits(context.Background(), rows)
	after := RunWaitForTask(rows[0])
	if *after.Occupied != 9 || !before.Since.Equal(after.Since) || string(rows[0].WaitHistory) != history {
		t.Fatalf("capacity sample reset wait interval: before=%+v after=%+v", before, after)
	}
	f.fx.Exec(t, `UPDATE agent_runtime SET daemon_capacity=daemon_capacity || jsonb_build_object('evaluated_at',now()-interval '1 minute') WHERE id=$1`, f.runtimeID)
	rows = f.svc.RefreshRunWaits(context.Background(), rows)
	if got := RunWaitForTask(rows[0]); got.Code != "awaiting_claim" {
		t.Fatalf("expired machine sample: %+v", got)
	}
	f.fx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", row.ID)
	ended, _ := f.svc.Queries.GetAgentTask(context.Background(), row.ID)
	if RunWaitForTask(ended) != nil || len(ended.WaitDiagnostic) != 0 {
		t.Fatal("cancelled task retains wait")
	}
}

func TestRunWaitHistoryIsBoundedAndDoesNotCrossAgents(t *testing.T) {
	f := newClaimDecisionFixture(t, 5)
	other := f.fx.Agent(t, "Independent agent", util.UUIDToString(f.runtimeID))
	f.fx.Task(t, other, testutil.Cols{"runtime_id": f.runtimeID, "issue_id": f.issueID, "status": "running"})
	id := f.insertTask(t, "queued")
	task, err := f.svc.ClaimTask(context.Background(), f.agentID)
	if err != nil || task == nil || util.UUIDToString(task.ID) != id {
		t.Fatalf("other agent incorrectly blocked this run: %+v %v", task, err)
	}
	for i := 0; i < 40; i++ {
		code := "preparing_session"
		if i%2 == 0 {
			code = "local_directory_busy"
		}
		updated, err := f.svc.SetRunPreparation(context.Background(), *task, code)
		if err != nil {
			t.Fatal(err)
		}
		task = &updated
	}
	var history []any
	if err := json.Unmarshal(task.WaitHistory, &history); err != nil || len(history) != 32 {
		t.Fatalf("unbounded history (%d): %v", len(history), err)
	}
}

func TestRunWaitDoesNotExposePrivateChatBlocker(t *testing.T) {
	f := newClaimDecisionFixture(t, 5)
	sessionID := f.fx.Insert(t, "chat_session", testutil.Cols{"workspace_id": f.fx.WorkspaceID, "creator_id": f.fx.UserID, "agent_id": f.agentID})
	f.fx.Task(t, util.UUIDToString(f.agentID), testutil.Cols{"runtime_id": f.runtimeID, "chat_session_id": sessionID, "status": "running"})
	queued := f.fx.Task(t, util.UUIDToString(f.agentID), testutil.Cols{"runtime_id": f.runtimeID, "chat_session_id": sessionID})
	row, _ := f.svc.Queries.GetAgentTask(context.Background(), util.MustParseUUID(queued))
	rows := f.svc.RefreshRunWaits(context.Background(), []db.AgentTaskQueue{row})
	got := RunWaitForTask(rows[0])
	if got.Code != "previous_run" || got.Scope != "chat_session" || got.BlockingTaskID != "" {
		t.Fatalf("chat blocker: %+v", got)
	}
}
