package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestLocalSession(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "首次打开自动准备工作区"
		if existing {
			name = "重启后沿用原有用户和任务"
		}
		t.Run(name, func(t *testing.T) {
			pool := testutil.IsolatedDB(t, testPool.Config().ConnString())
			h := *testHandler
			h.Queries = db.New(pool)
			h.TxStarter = pool
			var existingUser, existingWorkspace string
			if existing {
				fixture := testutil.New(pool, "", "")
				existingUser = fixture.User(t, "原有用户", "existing@local.test")
				existingWorkspace = fixture.Workspace(t, "原有工作区", "existing")
				fixture.Insert(t, "member", testutil.Cols{
					"workspace_id": parseUUID(existingWorkspace), "user_id": parseUUID(existingUser), "role": "owner",
				})
			}
			open := func() LoginResponse {
				req := testutil.JSONRequest(http.MethodPost, "/auth/local", map[string]any{})
				req.RemoteAddr = "127.0.0.1:12345"
				var response LoginResponse
				testutil.Call(t, h.LocalSession, req).Want(http.StatusOK).JSON(&response)
				return response
			}
			first := open()
			if first.Token == "" || first.User.OnboardedAt == nil {
				t.Fatal("本机身份应自动准备好，不能继续要求登录或填写引导")
			}
			workspaces, err := h.Queries.ListWorkspaces(context.Background(), parseUUID(first.User.ID))
			if err != nil || len(workspaces) != 1 {
				t.Fatalf("工作区未准备好: %v, %v", workspaces, err)
			}
			if existing && (first.User.ID != existingUser || uuidToString(workspaces[0].ID) != existingWorkspace) {
				t.Fatal("免登录后应沿用原来的用户和工作区")
			}
			fixture := testutil.New(pool, uuidToString(workspaces[0].ID), first.User.ID)
			issueID := fixture.Issue(t, "重启后保留这个任务")
			second := open()
			if first.User.ID != second.User.ID {
				t.Fatal("重启后创建了另一个用户")
			}
			var count int
			if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM issue WHERE id=$1`, parseUUID(issueID)).Scan(&count); err != nil || count != 1 {
				t.Fatalf("重启后任务丢失: count=%d, error=%v", count, err)
			}
			if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workspace`).Scan(&count); err != nil || count != 1 {
				t.Fatalf("重复打开不应创建重复工作区: count=%d, error=%v", count, err)
			}
		})
	}
}

func TestLocalSessionRejectsExternalRequests(t *testing.T) {
	for _, origin := range []string{"https://example.com", "http://localhost.attacker.test"} {
		req := testutil.JSONRequest(http.MethodPost, "/auth/local", map[string]any{})
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Origin", origin)
		testutil.Call(t, testHandler.LocalSession, req).Want(http.StatusForbidden)
	}
	request := testutil.JSONRequest(http.MethodPost, "/auth/local", map[string]any{})
	request.RemoteAddr = "192.0.2.1:12345"
	testutil.Call(t, testHandler.LocalSession, request).Want(http.StatusForbidden)
}
