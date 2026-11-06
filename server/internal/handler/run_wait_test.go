package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestRunWaitCapacityCannotWriteAnotherWorkspace(t *testing.T) {
	owner := dbfx.User(t, "Wait foreign owner", "run-wait-foreign@example.com")
	ws := dbfx.Workspace(t, "Wait foreign workspace", "run-wait-foreign")
	foreign := testutil.New(testPool, ws, owner)
	runtimeID := foreign.Runtime(t, "Foreign wait runtime", testutil.Cols{"daemon_id": batchClaimTestDaemonID})
	req := newDaemonTokenRequest("POST", "/api/daemon/tasks/claim", map[string]any{
		"daemon_id": batchClaimTestDaemonID, "runtime_ids": []string{runtimeID}, "max_tasks": 0,
		"capacity": map[string]any{"occupied": 8, "limit": 8, "blocked": true},
	}, testWorkspaceID, batchClaimTestDaemonID)
	testutil.Call(t, testHandler.ClaimTasksByRuntime, req).Want(http.StatusOK)
	var untouched bool
	if err := testPool.QueryRow(context.Background(), "SELECT daemon_capacity IS NULL FROM agent_runtime WHERE id=$1", runtimeID).Scan(&untouched); err != nil || !untouched {
		t.Fatalf("foreign capacity mutated: untouched=%v, error=%v", untouched, err)
	}
}

func TestRunWaitAPIReportsCapacityAndClearsOnCancellation(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "Wait API runtime", testutil.Cols{"daemon_id": batchClaimTestDaemonID})
	agentID := dbfx.Agent(t, "Wait API agent", runtimeID, testutil.Cols{"max_concurrent_tasks": 1})
	issueID := dbfx.Issue(t, "Wait API issue")
	dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "running"})
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID})
	req := newOwnerDaemonRequest("POST", "/api/daemon/tasks/claim", map[string]any{
		"daemon_id": batchClaimTestDaemonID, "runtime_ids": []string{runtimeID}, "max_tasks": 0,
		"capacity": map[string]any{"occupied": 8, "limit": 8, "blocked": true},
	})
	testutil.Call(t, testHandler.ClaimTasksByRuntime, req).Want(http.StatusOK)
	var runs []AgentTaskResponse
	read := func() {
		t.Helper()
		runs = nil
		testutil.Call(t, testHandler.ListTasksByIssue, withURLParam(newRequest("GET", "/api/issues/"+issueID+"/task-runs", nil), "id", issueID)).Want(http.StatusOK).JSON(&runs)
	}
	read()
	found := false
	for _, run := range runs {
		if run.ID == taskID {
			found = true
			if run.WaitDiagnostic == nil || run.WaitDiagnostic.Code != "daemon_capacity" || *run.WaitDiagnostic.Limit != 8 {
				t.Fatalf("wait: %+v", run.WaitDiagnostic)
			}
		}
	}
	if !found {
		t.Fatal("queued run missing")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", taskID)
	read()
	for _, run := range runs {
		if run.ID == taskID && run.WaitDiagnostic != nil {
			t.Fatalf("stale terminal wait: %+v", run.WaitDiagnostic)
		}
	}
}

func TestRunWaitPreparationRejectsUnrecognizedTextAndTerminalWrites(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "Wait preparation runtime")
	agentID := dbfx.Agent(t, "Wait preparation agent", runtimeID)
	issueID := dbfx.Issue(t, "Wait preparation issue")
	taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "dispatched", "dispatched_at": testutil.Raw("now()")})
	call := func(code string, status int) {
		t.Helper()
		req := withURLParam(newOwnerDaemonRequest("POST", "/api/daemon/tasks/"+taskID+"/progress", map[string]any{"preparation_code": code}), "taskId", taskID)
		testutil.Call(t, testHandler.ReportTaskProgress, req).Want(status)
	}
	call("/private/credentials", http.StatusBadRequest)
	call("preparing_session", http.StatusOK)
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='cancelled',completed_at=now() WHERE id=$1", taskID)
	call("local_directory_busy", http.StatusConflict)
}
