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
	return chatSteerNegotiationFixture(t, "codex", []string{protocol.DaemonCapabilityTaskSupplementV1})
}

func chatSteerNegotiationFixture(t *testing.T, provider string, capabilities []string) (string, string, string) {
	t.Helper()
	runtimeID := dbfx.Runtime(t, "Chat steer runtime", testutil.Cols{"provider": provider})
	agentID := dbfx.Agent(t, "Chat steer agent", runtimeID)
	sessionID := createHandlerTestChatSession(t, agentID)
	generation := time.Now().UTC().Truncate(time.Microsecond)
	taskID := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id": runtimeID, "chat_session_id": sessionID,
		"status": "dispatched", "dispatched_at": generation,
	})
	req := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/start", map[string]any{
		"runtime_id": runtimeID, "dispatched_at": generation.Format(time.RFC3339Nano), "capabilities": capabilities,
	}), "taskId", taskID)
	testutil.Call(t, testHandler.StartTask, req).Want(http.StatusOK)
	dbfx.Cleanup(t, `DELETE FROM task_supplement_capability WHERE task_id=$1`, taskID)
	dbfx.Cleanup(t, `DELETE FROM chat_task_supplement WHERE task_id=$1`, taskID)
	return sessionID, taskID, runtimeID
}

func TestChatSteerNegotiatedCapability(t *testing.T) {
	for _, tc := range []struct {
		name, provider     string
		offered, supported bool
	}{
		{"supported", "codex", true, true}, {"legacy_daemon", "codex", false, false},
		{"qoder", "qoder", false, false}, {"qoder_cannot_offer_unsupported_transport", "qoder", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			capabilities := []string{}
			if tc.offered {
				capabilities = append(capabilities, protocol.DaemonCapabilityTaskSupplementV1)
			}
			sessionID, taskID, _ := chatSteerNegotiationFixture(t, tc.provider, capabilities)
			pendingReq := withChatTestWorkspaceCtx(t, withURLParam(newRequest(http.MethodGet, "/pending", nil), "sessionId", sessionID))
			var pending PendingChatTaskResponse
			testutil.Call(t, testHandler.GetPendingChatTask, pendingReq).Want(http.StatusOK).JSON(&pending)
			if pending.CanSteer == nil || *pending.CanSteer != tc.supported || pending.TaskID != taskID {
				t.Fatalf("pending = %+v", pending)
			}
			if tc.supported {
				return
			}
			var queued SendChatMessageResponse
			sendChatAddition(t, sessionID, taskID, "queue").Want(http.StatusCreated).JSON(&queued)
			var refusal struct {
				Code string `json:"code"`
			}
			req := withChatTestWorkspaceCtx(t, withURLParams(newRequest(http.MethodPost, "/steer", map[string]any{"expected_task_id": taskID}), "sessionId", sessionID, "taskId", queued.TaskID))
			testutil.Call(t, testHandler.SteerQueuedChatTask, req).Want(http.StatusConflict).JSON(&refusal)
			if refusal.Code != "chat_steer_unsupported" {
				t.Fatalf("queued refusal = %+v", refusal)
			}
			sendChatAddition(t, sessionID, taskID, "steer").Want(http.StatusConflict).JSON(&refusal)
			if refusal.Code != "chat_steer_unsupported" {
				t.Fatalf("direct refusal = %+v", refusal)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE id=$1 AND status='running'`, taskID); n != 1 {
				t.Fatal("refusal stopped the running task")
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE id=$1 AND task_id=$2`, queued.MessageID, queued.TaskID); n != 1 {
				t.Fatal("refusal changed the queued message")
			}
		})
	}
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

func TestQueuedChatSteerPreservesOriginalPrompt(t *testing.T) {
	sessionID, taskID, _ := chatSteerFixture(t)
	original := dbfx.Insert(t, "chat_message", testutil.Cols{"chat_session_id": sessionID, "task_id": taskID, "role": "user", "content": "Message A"})
	var queued SendChatMessageResponse
	sendChatAddition(t, sessionID, taskID, "queue").Want(http.StatusCreated).JSON(&queued)
	req := withChatTestWorkspaceCtx(t, withURLParams(newRequest(http.MethodPost, "/steer", map[string]any{"expected_task_id": taskID}), "sessionId", sessionID, "taskId", queued.TaskID))
	var sent SendChatMessageResponse
	testutil.Call(t, testHandler.SteerQueuedChatTask, req).Want(http.StatusOK).JSON(&sent)
	if sent.MessageID != queued.MessageID || sent.TaskID != taskID || !sent.Steered || sent.Queued {
		t.Fatalf("steer = %+v, queued = %+v", sent, queued)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE id=$1`, original); n != 1 {
		t.Fatalf("original prompt was withdrawn: %d", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE id=$1 AND status='running'`, taskID); n != 1 {
		t.Fatal("original run was stopped")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_draft_restore WHERE chat_session_id=$1`, sessionID); n != 0 {
		t.Fatalf("unexpected restored draft: %d", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_task_supplement WHERE message_id=$1 AND task_id=$2`, queued.MessageID, taskID); n != 1 {
		t.Fatal("queued message did not enter the running turn")
	}
	retry := withChatTestWorkspaceCtx(t, withURLParams(newRequest(http.MethodPost, "/steer", map[string]any{"expected_task_id": taskID}), "sessionId", sessionID, "taskId", queued.TaskID))
	var refusal struct {
		Code string `json:"code"`
	}
	testutil.Call(t, testHandler.SteerQueuedChatTask, retry).Want(http.StatusConflict).JSON(&refusal)
	if refusal.Code != "chat_steer_message_consumed" {
		t.Fatalf("duplicate refusal = %+v", refusal)
	}
}

func TestQueuedChatSteerRefusalPreservesMessagesAndQueue(t *testing.T) {
	for _, cause := range []string{"unsupported", "completed", "already_claimed", "another_session", "attachment", "invalid_target"} {
		t.Run(cause, func(t *testing.T) {
			sessionID, taskID, _ := chatSteerFixture(t)
			var queued SendChatMessageResponse
			sendChatAddition(t, sessionID, taskID, "queue").Want(http.StatusCreated).JSON(&queued)
			expectedStatus := http.StatusConflict
			targetID := taskID
			switch cause {
			case "unsupported":
				dbfx.Exec(t, `DELETE FROM task_supplement_capability WHERE task_id=$1`, taskID)
			case "completed":
				completeTaskViaDaemon(t, taskID)
			case "already_claimed":
				dbfx.Exec(t, `UPDATE agent_task_queue SET status='dispatched' WHERE id=$1`, queued.TaskID)
			case "another_session":
				dbfx.Exec(t, `UPDATE agent_task_queue SET chat_session_id=NULL WHERE id=$1`, queued.TaskID)
			case "attachment":
				dbfx.Insert(t, "attachment", testutil.Cols{"workspace_id": testWorkspaceID, "chat_session_id": sessionID, "chat_message_id": queued.MessageID, "uploader_type": "member", "uploader_id": testUserID, "filename": "image.png", "url": "/image.png", "content_type": "image/png", "size_bytes": 1})
			case "invalid_target":
				targetID = "not-a-uuid"
				expectedStatus = http.StatusBadRequest
			}
			req := withChatTestWorkspaceCtx(t, withURLParams(newRequest(http.MethodPost, "/steer", map[string]any{"expected_task_id": targetID}), "sessionId", sessionID, "taskId", queued.TaskID))
			var refusal struct {
				Code string `json:"code"`
			}
			testutil.Call(t, testHandler.SteerQueuedChatTask, req).Want(expectedStatus).JSON(&refusal)
			wantCode := map[string]string{"unsupported": "chat_steer_unsupported", "completed": "chat_steer_target_changed", "already_claimed": "chat_steer_message_consumed", "another_session": "chat_steer_message_consumed", "attachment": "chat_steer_unavailable"}[cause]
			if refusal.Code != wantCode {
				t.Fatalf("refusal code = %q, want %q", refusal.Code, wantCode)
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE id=$1 AND task_id=$2`, queued.MessageID, queued.TaskID); n != 1 {
				t.Fatal("refused input changed")
			}
			if n := dbfx.Count(t, `SELECT count(*) FROM chat_task_supplement WHERE message_id=$1`, queued.MessageID); n != 0 {
				t.Fatal("refused input was delivered")
			}
		})
	}
}

func TestQueuedChatSteerOutOfOrderReceipts(t *testing.T) {
	sessionID, taskID, _ := chatSteerFixture(t)
	var queued [2]SendChatMessageResponse
	for i := range queued {
		sendChatAddition(t, sessionID, taskID, "queue").Want(http.StatusCreated).JSON(&queued[i])
	}
	for _, i := range []int{1, 0} {
		req := withChatTestWorkspaceCtx(t, withURLParams(newRequest(http.MethodPost, "/steer", map[string]any{"expected_task_id": taskID}), "sessionId", sessionID, "taskId", queued[i].TaskID))
		testutil.Call(t, testHandler.SteerQueuedChatTask, req).Want(http.StatusOK)
		claim := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/claim", nil), "taskId", taskID)
		testutil.Call(t, testHandler.ClaimTaskSupplement, claim).Want(http.StatusOK)
	}
	for _, i := range []int{0, 1} {
		ack := withURLParams(newOwnerDaemonRequest(http.MethodPost, "/ack", map[string]any{"delivered": i == 1, "error": "provider rejected input"}), "taskId", taskID, "commentId", queued[i].MessageID)
		testutil.Call(t, testHandler.AckTaskSupplement, ack).Want(http.StatusOK)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1 AND task_id=$2`, sessionID, taskID); n != 2 {
		t.Fatalf("receipt order lost or duplicated messages: %d", n)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_task_supplement WHERE task_id=$1 AND status='delivered'`, taskID); n != 1 {
		t.Fatal("successful receipt was lost")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_task_supplement WHERE task_id=$1 AND status='failed'`, taskID); n != 1 {
		t.Fatal("failed receipt was hidden")
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM chat_draft_restore WHERE chat_session_id=$1`, sessionID); n != 0 {
		t.Fatal("failed receipt restored an unrelated prompt")
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
			var refusal struct {
				Code string `json:"code"`
			}
			sendChatAddition(t, sessionID, taskID, "steer").Want(http.StatusConflict).JSON(&refusal)
			wantCode := "chat_steer_target_changed"
			if cause == "unsupported" {
				wantCode = "chat_steer_unsupported"
			}
			if refusal.Code != wantCode {
				t.Fatalf("refusal code = %q, want %q", refusal.Code, wantCode)
			}
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
