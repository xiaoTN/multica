package localnetwork

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestLocalPolicy(t *testing.T) {
	originalTransport, originalClient, originalWS := http.DefaultTransport, http.DefaultClient.Transport, websocket.DefaultDialer
	originalResolver := net.DefaultResolver
	t.Setenv("REDIS_URL", "")
	t.Setenv("DATABASE_REPLICA_URL", "")
	t.Setenv("OPENAI_API_KEY", "test-model-key")
	for _, key := range []string{"DO_NOT_TRACK", "ANALYTICS_DISABLED", "POSTHOG_API_KEY", "MULTICA_DAEMON_AUTO_UPDATE", "MULTICA_CLOUD_URL", "RESEND_API_KEY", "SMTP_HOST", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "S3_BUCKET", "CLOUDFRONT_DOMAIN", "MULTICA_LLM_API_KEY"} {
		t.Setenv(key, "")
	}
	Activate()
	t.Cleanup(func() {
		active.Store(false)
		net.DefaultResolver = originalResolver
		http.DefaultTransport = originalTransport
		http.DefaultClient.Transport = originalClient
		websocket.DefaultDialer = originalWS
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://example.com/", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("local"))
	}))
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	for _, raw := range []string{"https://example.com", "http://192.168.1.1", "http://localhost.example.com", server.URL + "/redirect"} {
		if response, err := http.Get(raw); err == nil {
			response.Body.Close()
			t.Fatalf("外部请求未被拦截：%s", raw)
		}
	}
	if _, err := DialContext(context.Background(), "tcp", "example.com:443"); err == nil {
		t.Fatal("不应解析或连接外部地址")
	}
	if _, _, err := websocket.DefaultDialer.Dial("wss://example.com/ws", nil); err == nil {
		t.Fatal("外部 WebSocket 未被拦截")
	}
	if _, err := net.DefaultResolver.LookupHost(context.Background(), "must-not-resolve.invalid"); err == nil {
		t.Fatal("不应查询外部域名")
	}
	t.Setenv("DATABASE_URL", "postgres://user:secret@192.168.1.10/db")
	if ValidateLocalServices() == nil {
		t.Fatal("远程数据库未被拒绝")
	}
	t.Setenv("DATABASE_URL", "postgres://user:secret@127.0.0.1/db")
	if err := ValidateLocalServices(); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("OPENAI_API_KEY") != "test-model-key" {
		t.Fatal("不应修改独立 AI 工具的模型配置")
	}
	command := exec.Command("git", "ls-remote", server.URL)
	command.Env = GitEnv(os.Environ())
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "not allowed") {
		t.Fatalf("Multica 管理的 Git 不应连接 HTTP 仓库：%s，%v", output, err)
	}
}
