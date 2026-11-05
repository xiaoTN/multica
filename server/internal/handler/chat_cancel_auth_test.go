package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestChatCancelThenContinueAuthenticatesAsNewRun(t *testing.T) {
	if testHandler == nil {
		t.Skip("验收需要独立测试数据库")
	}
	ctx := context.Background()
	agentID, runtimeID, _ := createRuntimeGuardAgent(t, ctx)
	chatID := dbfx.ChatSession(t, agentID, testutil.Cols{"title": "取消后续接验收", "runtime_id": runtimeID})
	issueID := dbfx.Issue(t, "续接运行的读写目标")
	router := chi.NewRouter()
	router.Use(middleware.Auth(testHandler.Queries, nil, nil, nil))
	router.Get("/api/issues/{id}", testHandler.GetIssue)
	router.Post("/api/issues/{id}/comments", testHandler.CreateComment)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	var previousToken string
	for turn := 1; turn <= 3; turn++ {
		taskID := dbfx.Task(t, agentID, testutil.Cols{
			"runtime_id": runtimeID, "chat_session_id": chatID, "status": "queued",
		})
		req := withURLParam(newOwnerDaemonRequest(http.MethodPost, "/api/daemon/runtimes/"+runtimeID+"/claim", nil), "runtimeId", runtimeID)
		var claimed struct {
			Task *AgentTaskResponse `json:"task"`
		}
		testutil.Call(t, testHandler.ClaimTaskByRuntime, req).Want(http.StatusOK).JSON(&claimed)
		if claimed.Task == nil || claimed.Task.ID != taskID || claimed.Task.AuthToken == "" {
			t.Fatal("没有领到本轮运行及其专用凭证")
		}
		task := claimed.Task
		t.Cleanup(func() { _ = testHandler.Queries.DeleteTaskTokensByTask(context.Background(), parseUUID(taskID)) })
		if task.AuthToken == previousToken {
			t.Fatal("新运行复用了上一轮的凭证")
		}
		if turn > 1 && task.PriorSessionID != "same-provider-session" {
			t.Fatal("取消后没有保留聊天上下文")
		}

		client := cli.NewAPIClient(srv.URL, testWorkspaceID, task.AuthToken)
		var issue IssueResponse
		if err := client.GetJSON(ctx, "/api/issues/"+issueID, &issue); err != nil || issue.ID != issueID {
			t.Fatalf("第 %d 轮无法查询任务：%v", turn, err)
		}
		var comment CommentResponse
		if err := client.PostJSON(ctx, "/api/issues/"+issueID+"/comments", map[string]string{"content": "取消后仍可执行"}, &comment); err != nil {
			t.Fatalf("第 %d 轮无法写入验收评论：%v", turn, err)
		}
		var authorID, authorType string
		dbfx.QueryRow(t, `SELECT author_id, author_type FROM comment WHERE id = $1`, comment.ID).Scan(&authorID, &authorType)
		if authorID != agentID || authorType != "agent" {
			t.Fatal("续接操作没有使用智能体身份")
		}
		t.Logf("第 %d 轮：沿用会话，使用独立凭证，任务查询和评论写入成功", turn)
		if turn == 3 {
			break
		}

		dbfx.Exec(t, `UPDATE agent_task_queue SET status = 'running', started_at = now(), session_id = 'same-provider-session', work_dir = '/tmp/cancel-auth-workdir' WHERE id = $1`, taskID)
		if _, err := testHandler.TaskService.CancelTaskWithResult(ctx, parseUUID(taskID), service.CancelTaskOptions{ClientSupportsDraftRestore: true}); err != nil {
			t.Fatalf("取消第 %d 轮失败：%v", turn, err)
		}
		err := client.GetJSON(ctx, "/api/issues/"+issueID, &issue)
		var rejected *cli.HTTPError
		if !errors.As(err, &rejected) || rejected.StatusCode != http.StatusUnauthorized || !rejected.TaskScoped {
			t.Fatal("取消后旧凭证仍可访问平台，或未正确识别为运行凭证拒绝")
		}
		previousToken = task.AuthToken
	}
}
