package handler

import (
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func chatSteerFixture(t *testing.T) (string, string, string) {
	t.Helper()
	runtimeID := dbfx.Runtime(t, "Chat steer runtime", testutil.Cols{"provider": "codex"})
	agentID := dbfx.Agent(t, "Chat steer agent", runtimeID)
	sessionID := createHandlerTestChatSession(t, agentID)
	generation := time.Now().UTC().Truncate(time.Microsecond)
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": runtimeID, "chat_session_id": sessionID,
		"status": "dispatched", "dispatched_at": generation,
	})
	req := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/start", map[string]any{
		"runtime_id": runtimeID, "dispatched_at": generation.Format(time.RFC3339Nano), "capabilities": []string{protocol.DaemonCapabilityTaskSupplementV1},
	}), "taskId", taskID)
	testutil.Call(t, testHandler.StartTask, req).Want(http.StatusOK)
	dbfx.Cleanup(t, `DELETE FROM task_supplement_capability WHERE task_id=$1`, taskID)
	dbfx.Cleanup(t, `DELETE FROM chat_task_supplement WHERE task_id=$1`, taskID)
	return sessionID, taskID, runtimeID
}

func sendChatAddition(t *testing.T, sessionID, taskID, mode string) *testutil.Response {
	t.Helper()
	req := withChatTestWorkspaceCtx(t, withURLParam(newRequest(http.MethodPost, "/messages", map[string]any{
		"content": "additional instruction", "mode": mode, "expected_task_id": taskID,
	}), "sessionId", sessionID))
	return testutil.Call(t, testHandler.SendChatMessage, req)
}

func TestChatSteerKeepsTheRunningTurn(t *testing.T) {
	sessionID, taskID, _ := chatSteerFixture(t)
	var sent SendChatMessageResponse
	sendChatAddition(t, sessionID, taskID, "steer").Want(http.StatusCreated).JSON(&sent)
	if !sent.Steered || sent.Queued || sent.TaskID != taskID {
		t.Fatalf("send = %+v", sent)
	}
	if count := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE chat_session_id=$1`, sessionID); count != 1 {
		t.Fatalf("steer created another task: %d", count)
	}
	var claimed map[string]any
	claim := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/claim", map[string]any{}), "taskId", taskID)
	testutil.Call(t, testHandler.ClaimTaskSupplement, claim).Want(http.StatusOK).JSON(&claimed)
	if claimed["message_id"] != sent.MessageID || claimed["content"] != "additional instruction" {
		t.Fatalf("claim = %+v", claimed)
	}
	ack := withURLParams(newOwnerDaemonRequest(http.MethodPost, "/ack", map[string]any{"delivered": true}), "taskId", taskID, "commentId", sent.MessageID)
	testutil.Call(t, testHandler.AckTaskSupplement, ack).Want(http.StatusOK)
	ackAgain := withURLParams(newOwnerDaemonRequest(http.MethodPost, "/ack", map[string]any{"delivered": true}), "taskId", taskID, "commentId", sent.MessageID)
	testutil.Call(t, testHandler.AckTaskSupplement, ackAgain).Want(http.StatusOK)
	receipts, err := testHandler.Queries.ListChatTaskSupplements(t.Context(), parseUUID(sessionID))
	if err != nil || len(receipts) != 1 || receipts[0].Status != "delivered" || !receipts[0].DeliveredAt.Valid {
		t.Fatalf("receipts=%+v err=%v", receipts, err)
	}
}

func TestChatSteerRefusesUnavailableExactTurnWithoutQueueing(t *testing.T) {
	for _, cause := range []string{"completed", "unsupported", "another_session"} {
		t.Run(cause, func(t *testing.T) {
			sessionID, taskID, _ := chatSteerFixture(t)
			switch cause {
			case "completed":
				completeTaskViaDaemon(t, taskID)
			case "unsupported":
				dbfx.Exec(t, `DELETE FROM task_supplement_capability WHERE task_id=$1`, taskID)
			case "another_session":
				dbfx.Exec(t, `UPDATE agent_task_queue SET chat_session_id=NULL WHERE id=$1`, taskID)
			}
			sendChatAddition(t, sessionID, taskID, "steer").Want(http.StatusConflict)
			if count := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1 AND role='user'`, sessionID); count != 0 {
				t.Fatalf("refused steer persisted %d messages", count)
			}
		})
	}
}

func TestChatSteerExplicitQueueAndTerminalSettlement(t *testing.T) {
	sessionID, taskID, _ := chatSteerFixture(t)
	var queued SendChatMessageResponse
	sendChatAddition(t, sessionID, taskID, "queue").Want(http.StatusCreated).JSON(&queued)
	if queued.Steered || !queued.Queued || queued.TaskID == taskID {
		t.Fatalf("queue = %+v", queued)
	}
	sendChatAddition(t, sessionID, taskID, "steer").Want(http.StatusCreated)
	completeTaskViaDaemon(t, taskID)
	receipts, err := testHandler.Queries.ListChatTaskSupplements(t.Context(), parseUUID(sessionID))
	if err != nil || len(receipts) != 1 || receipts[0].Status != "failed" || receipts[0].FailureReason.String != "turn_ended" {
		t.Fatalf("receipts=%+v err=%v", receipts, err)
	}
}

func TestChatSteerLateAcknowledgementDoesNotClaimUndeliveredInput(t *testing.T) {
	sessionID, taskID, _ := chatSteerFixture(t)
	var delivered, pending SendChatMessageResponse
	sendChatAddition(t, sessionID, taskID, "steer").Want(http.StatusCreated).JSON(&delivered)
	claim := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/claim", nil), "taskId", taskID)
	testutil.Call(t, testHandler.ClaimTaskSupplement, claim).Want(http.StatusOK)
	sendChatAddition(t, sessionID, taskID, "steer").Want(http.StatusCreated).JSON(&pending)
	completeTaskViaDaemon(t, taskID)
	for _, tc := range []struct {
		id     string
		status int
	}{{delivered.MessageID, http.StatusOK}, {pending.MessageID, http.StatusConflict}} {
		req := withURLParams(newOwnerDaemonRequest(http.MethodPost, "/ack", map[string]any{"delivered": true}), "taskId", taskID, "commentId", tc.id)
		testutil.Call(t, testHandler.AckTaskSupplement, req).Want(tc.status)
	}
}

func TestChatSteerAttachmentsKeepTheDraftUnaccepted(t *testing.T) {
	sessionID, taskID, _ := chatSteerFixture(t)
	req := withChatTestWorkspaceCtx(t, withURLParam(newRequest(http.MethodPost, "/messages", map[string]any{
		"content": "with an attachment", "mode": "steer", "expected_task_id": taskID,
		"attachment_ids": []string{taskID},
	}), "sessionId", sessionID))
	testutil.Call(t, testHandler.SendChatMessage, req).Want(http.StatusConflict)
	if count := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1`, sessionID); count != 0 {
		t.Fatalf("refused attachment steer persisted %d messages", count)
	}
}
