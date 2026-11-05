//go:build agentintegration

package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/daemon"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/agent"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// This opt-in smoke uses only an isolated development database and a temporary
// HTTP server. No requests or fixture credentials reach the user's workspace.
func TestCodexRealChatSteerBeforeCompletion(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("real agent smoke is opt-in")
	}
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if !strings.Contains(databaseURL, "/multica_worktree_") {
		t.Fatal("an isolated worktree database is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	fx := testutil.New(pool, "", "")
	suffix := fmt.Sprint(time.Now().UnixNano())
	userID := fx.User(t, "Steer smoke", "steer-"+suffix+"@example.invalid")
	workspaceID := fx.Workspace(t, "Steer smoke", "steer-"+suffix)
	fx.UserID, fx.WorkspaceID = userID, workspaceID
	fx.Member(t, workspaceID, userID, "owner")
	runtimeID := fx.Runtime(t, "Codex smoke", testutil.Cols{"provider": "codex"})
	agentID := fx.Agent(t, "Codex smoke", runtimeID)
	chatID := fx.Insert(t, "chat_session", testutil.Cols{"workspace_id": workspaceID, "agent_id": agentID, "creator_id": userID, "title": "Steer smoke", "status": "active"})
	taskID := fx.Task(t, agentID, testutil.Cols{"chat_session_id": chatID, "runtime_id": runtimeID, "status": "dispatched"})
	fx.Insert(t, "chat_message", testutil.Cols{"chat_session_id": chatID, "role": "user", "content": "Original chat objective", "task_id": taskID})
	fx.Cleanup(t, `DELETE FROM task_supplement_capability WHERE task_id=$1`, taskID)
	fx.Cleanup(t, `DELETE FROM chat_task_supplement WHERE task_id=$1`, taskID)
	q := db.New(pool)
	hub := realtime.NewHub()
	go hub.Run()
	h := handler.New(q, pool, hub, events.New(), service.NewEmailService(), nil, nil, analytics.NoopClient{}, handler.Config{})
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: util.MustParseUUID(userID), WorkspaceID: util.MustParseUUID(workspaceID)})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Header.Set("X-User-ID", userID)
			r.Header.Set("X-Workspace-ID", workspaceID)
			next.ServeHTTP(w, r.WithContext(middleware.SetMemberContext(r.Context(), workspaceID, member)))
		})
	})
	router.Post("/api/chat/sessions/{sessionId}/messages", h.SendChatMessage)
	router.Post("/api/daemon/tasks/{taskId}/supplements/claim", h.ClaimTaskSupplement)
	router.Post("/api/daemon/tasks/{taskId}/supplements/{commentId}/ack", h.AckTaskSupplement)
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	if _, err := h.TaskService.StartTask(ctx, util.MustParseUUID(taskID), service.TaskStartCapabilities{Supplement: true}); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	codexHome := filepath.Join(root, "codex-home")
	if err := os.Mkdir(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	originalHome := os.Getenv("CODEX_HOME")
	if originalHome == "" {
		home, _ := os.UserHomeDir()
		originalHome = filepath.Join(home, ".codex")
	}
	if err := os.Symlink(filepath.Join(originalHome, "auth.json"), filepath.Join(codexHome, "auth.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("approval_policy = \"never\"\nsandbox_mode = \"workspace-write\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	backend, err := agent.New("codex", agent.Config{ExecutablePath: codexPath, Env: map[string]string{"CODEX_HOME": codexHome}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), TaskID: taskID})
	if err != nil {
		t.Fatal(err)
	}
	session, err := backend.Execute(ctx, "This is an isolated delivery test. Use the shell tool to run `sleep 8` exactly once, then reply ORIGINAL. If additional guidance arrives while you work, also follow it in the same final response. Do not read files or access any services.", agent.ExecOptions{Cwd: root, Model: "gpt-6-astra", ThinkingLevel: "low", EnableTaskSupplement: true})
	if err != nil {
		t.Fatal(err)
	}
	client := daemon.NewClient(srv.URL)
	marker := "RECEIVED_" + suffix
	var sent handler.SendChatMessageResponse
	var deliveredAt time.Time
	messages := session.Messages
	for {
		select {
		case message, open := <-messages:
			if !open {
				messages = nil
				continue
			}
			if sent.MessageID != "" || message.Type != agent.MessageToolUse {
				continue
			}
			if session.SupplementReady == nil || !session.SupplementReady() {
				t.Fatal("real active turn is not steerable")
			}
			raw, _ := json.Marshal(map[string]string{"content": "Also include the exact marker " + marker + " in your final response.", "mode": "steer", "expected_task_id": taskID})
			response, err := http.Post(srv.URL+"/api/chat/sessions/"+chatID+"/messages", "application/json", bytes.NewReader(raw))
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusCreated {
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				t.Fatalf("send: %d %s", response.StatusCode, body)
			}
			err = json.NewDecoder(response.Body).Decode(&sent)
			response.Body.Close()
			if err != nil || !sent.Steered || sent.TaskID != taskID {
				t.Fatalf("send=%+v error=%v", sent, err)
			}
			addition, err := client.ClaimTaskSupplement(ctx, taskID)
			if err != nil || addition == nil || addition.MessageID != sent.MessageID {
				t.Fatalf("claim=%+v error=%v", addition, err)
			}
			if err := session.Supplement(ctx, "Additional human guidance for the same task: "+addition.Content); err != nil {
				t.Fatal(err)
			}
			if err := client.AckTaskSupplement(ctx, taskID, addition.MessageID, true, ""); err != nil {
				t.Fatal(err)
			}
			deliveredAt = time.Now().UTC()
			t.Logf("message=%s run=%s delivered=%s (original turn still active)", sent.MessageID, taskID, deliveredAt.Format(time.RFC3339Nano))
		case result := <-session.Result:
			completedAt := time.Now().UTC()
			if sent.MessageID == "" || deliveredAt.IsZero() || !deliveredAt.Before(completedAt) || result.Status != "completed" || !strings.Contains(result.Output, marker) || !strings.Contains(result.Output, "ORIGINAL") {
				t.Fatalf("same-turn delivery failed: sent=%t status=%s output=%q", sent.Steered, result.Status, result.Output)
			}
			if count := fx.Count(t, `SELECT count(*) FROM agent_task_queue WHERE chat_session_id=$1`, chatID); count != 1 {
				t.Fatalf("created %d runs", count)
			}
			if count := fx.Count(t, `SELECT count(*) FROM chat_task_supplement WHERE message_id=$1 AND status='delivered' AND delivered_at IS NOT NULL`, sent.MessageID); count != 1 {
				t.Fatal("missing durable delivery receipt")
			}
			t.Logf("run=%s completed=%s output=%q; one run, no cancellation or restart", taskID, completedAt.Format(time.RFC3339Nano), result.Output)
			return
		case <-ctx.Done():
			t.Fatal("real chat steer smoke timed out")
		}
	}
}
