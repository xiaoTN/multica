//go:build agentintegration

package agent_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon"
	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// 仅在明确授权后运行：真实 Codex 会产生少量模型调用，平台请求全部发往临时验收服务。
// MULTICA_TEST_CLI_PATH 必须指向由本次源码编译的 multica，避免误测旧版本。
func TestCodexRealCancelThenResumeWithFreshTaskAuthentication(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("真实智能体验收需要显式开启")
	}
	codexPath, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal("找不到 Codex，无法进行真实续接验收")
	}
	cliPath := os.Getenv("MULTICA_TEST_CLI_PATH")
	if !filepath.IsAbs(cliPath) {
		t.Fatal("需要本次编译的 CLI 绝对路径")
	}
	if _, err := os.Stat(cliPath); err != nil {
		t.Fatal("验收 CLI 不存在")
	}
	const oldToken, nextToken = "mat_smoke_cancelled", "mat_smoke_followup"
	var oldCalls, nextCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet || (r.URL.Path != "/api/issues/SMOKE-1" && r.URL.Path != "/api/issues/11111111-1111-4111-8111-111111111111") {
			http.NotFound(w, r)
			return
		}
		switch r.Header.Get("Authorization") {
		case "Bearer " + oldToken:
			oldCalls.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"invalid token"}`)
		case "Bearer " + nextToken:
			nextCalls.Add(1)
			_, _ = io.WriteString(w, `{"id":"11111111-1111-4111-8111-111111111111","identifier":"SMOKE-1","title":"续接验收成功","status":"todo"}`)
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	t.Cleanup(srv.Close)

	root := t.TempDir()
	codexHome := filepath.Join(root, "codex-home")
	if err := os.Mkdir(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	// 隔离配置允许访问临时本机服务，不改动用户的 Codex 设置。
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("approval_policy = \"never\"\nsandbox_mode = \"workspace-write\"\n[sandbox_workspace_write]\nnetwork_access = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sharedHome := os.Getenv("CODEX_HOME")
	if sharedHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Fatal(err)
		}
		sharedHome = filepath.Join(home, ".codex")
	}
	if err := os.Symlink(filepath.Join(sharedHome, "auth.json"), filepath.Join(codexHome, "auth.json")); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	run := func(task daemon.Task, cancelOnRejection bool) agent.Result {
		t.Helper()
		env := map[string]string{
			"CODEX_HOME": codexHome, "MULTICA_TOKEN": task.AuthToken, "MULTICA_TASK_ID": task.ID,
			"MULTICA_SERVER_URL": srv.URL, "MULTICA_WORKSPACE_ID": "22222222-2222-4222-8222-222222222222",
			"MULTICA_TASK_CONFIG_ROOT": filepath.Join(root, "cli-config"),
		}
		if err := execenv.EnsureCodexShellEnvPolicyConfig(filepath.Join(codexHome, "config.toml"), execenv.CodexShellEnvAllowlist(os.Environ(), env, nil), logger); err != nil {
			t.Fatal(err)
		}
		backend, err := agent.New("codex", agent.Config{ExecutablePath: codexPath, Env: env, Logger: logger, TaskID: task.ID})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		session, err := backend.Execute(ctx, daemon.BuildPrompt(task, "codex"), agent.ExecOptions{
			Cwd: root, Model: "gpt-6-astra", ThinkingLevel: "low", ResumeSessionID: task.PriorSessionID,
		})
		if err != nil {
			t.Fatal(err)
		}
		interrupted := false
		toolResults := 0
		messages := session.Messages
		for {
			select {
			case message, ok := <-messages:
				if !ok {
					messages = nil
					continue
				}
				// 确认拒绝结果已进入会话历史后再中断，重现旧报错污染续接的条件。
				if message.Type == agent.MessageToolResult {
					toolResults++
				}
				if cancelOnRejection && !interrupted && message.Type == agent.MessageToolResult && oldCalls.Load() > 0 {
					interrupted = true
					t.Log("已确认旧报错进入会话，正在取消第一轮")
					cancel()
				}
			case result := <-session.Result:
				if cancelOnRejection && !interrupted {
					t.Fatalf("没有在凭证拒绝后触发取消，状态：%s，旧请求数：%d，工具结果数：%d", result.Status, oldCalls.Load(), toolResults)
				}
				return result
			case <-ctx.Done():
				if !interrupted {
					t.Fatal("真实续接验收超时")
				}
				// 取消后仍要读取后台的退出结果，确认进程已回收。
				select {
				case result := <-session.Result:
					return result
				case <-time.After(20 * time.Second):
					t.Fatal("取消后智能体没有退出")
				}
			}
		}
	}
	old := run(daemon.Task{
		ID: "cancelled-smoke-run", ChatSessionID: "smoke-chat", AuthToken: oldToken,
		ChatMessage: "这是隔离验收。先用 shell 工具执行 `" + cliPath + " issue get SMOKE-1 --output json`。收到结果后，再单独运行 `sleep 30`，供测试中断；查询失败也需要执行这一步等待。不要读取任何文件或凭证，不要调用其他服务。",
	}, true)
	if old.Status != "aborted" || old.SessionID == "" || oldCalls.Load() != 1 {
		t.Fatalf("旧一轮未按预期取消：状态=%s，会话存在=%t，请求数=%d", old.Status, old.SessionID != "", oldCalls.Load())
	}
	result := run(daemon.Task{
		ID: "followup-smoke-run", ChatSessionID: "smoke-chat", AuthToken: nextToken, PriorSessionID: old.SessionID,
		ChatMessage: "继续查询刚才的 SMOKE-1，只回复它现在的标题。CLI 路径仍为 " + cliPath + "。只允许访问刚才的隔离验收服务，不读取其他文件。",
	}, false)
	if result.Status != "completed" || result.SessionID != old.SessionID || nextCalls.Load() == 0 || oldCalls.Load() != 1 || !strings.Contains(result.Output, "续接验收成功") {
		t.Fatalf("续接未实际执行：状态=%s，同一会话=%t，新请求=%d，旧请求=%d，标题正确=%t", result.Status, result.SessionID == old.SessionID, nextCalls.Load(), oldCalls.Load(), strings.Contains(result.Output, "续接验收成功"))
	}
	t.Log("真实 Codex 验收通过：旧凭证拒绝后取消，保留会话，下一轮用新凭证实际查询成功")
}
