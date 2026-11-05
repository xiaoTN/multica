package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCreateCommentRepliesToCurrentRunSupplement(t *testing.T) {
	for _, status := range []string{"delivering", "delivered", "pending", "failed", "unbound", "other run"} {
		t.Run(status, func(t *testing.T) {
			f := newSupplementFixture(t, "codex", "running", true)
			comment := dbfx.Comment(t, f.issueID, "Received, local delivery only", testutil.Cols{"parent_id": f.triggerID})
			if status != "unbound" {
				boundTask := f.taskID
				storedStatus := status
				if status == "other run" {
					boundTask = dbfx.Task(t, f.agentID, testutil.Cols{"issue_id": f.issueID, "runtime_id": f.runtimeID})
					storedStatus = "delivered"
				}
				dbfx.InsertNoID(t, "task_supplement", testutil.Cols{
					"task_id": boundTask, "workspace_id": testWorkspaceID, "issue_id": f.issueID,
					"comment_id": comment, "author_id": testUserID,
					"client_request_id": "11111111-1111-4111-8111-111111111111", "status": storedStatus,
				}, "task_id=$1 AND comment_id=$2", boundTask, comment)
			}
			r := withURLParam(newRequest(http.MethodPost, "/api/issues/"+f.issueID+"/comments", map[string]string{
				"content": "Received; I will deliver locally.", "parent_id": comment,
			}), "id", f.issueID)
			r.Header.Set("X-Actor-Source", "task_token")
			r.Header.Set("X-Agent-ID", f.agentID)
			r.Header.Set("X-Task-ID", f.taskID)
			want := http.StatusConflict
			if status == "delivering" || status == "delivered" {
				want = http.StatusCreated
			}
			testutil.Call(t, testHandler.CreateComment, r).Want(want)
		})
	}
}
