// Package localnetwork 限制 Multica 自身的网络连接；独立 AI 工具仍可调用云模型。
package localnetwork

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

var active atomic.Bool

func Enabled() bool { return active.Load() }

// Activate 在二进制入口执行，不能通过运行配置重新允许外部连接。
func Activate() {
	active.Store(true)
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		return nil, fmt.Errorf("本机版本不查询外部域名")
	}}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = DialContext
	transport.DialTLSContext = nil
	http.DefaultTransport = transport
	http.DefaultClient.Transport = transport
	ws := *websocket.DefaultDialer
	ws.Proxy = nil
	ws.NetDialContext = DialContext
	ws.NetDialTLSContext = nil
	websocket.DefaultDialer = &ws
	// 这些开关只关闭 Multica 的上报和更新，不修改 AI 工具的模型地址或密钥。
	for key, value := range map[string]string{
		"DO_NOT_TRACK": "true", "ANALYTICS_DISABLED": "true", "POSTHOG_API_KEY": "",
		"MULTICA_DAEMON_AUTO_UPDATE": "false", "MULTICA_CLOUD_URL": "",
		"RESEND_API_KEY": "", "SMTP_HOST": "", "GOOGLE_CLIENT_ID": "", "GOOGLE_CLIENT_SECRET": "",
		"S3_BUCKET": "", "CLOUDFRONT_DOMAIN": "", "MULTICA_LLM_API_KEY": "",
	} {
		_ = os.Setenv(key, value)
	}
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// IsBrowserOrigin 只接受本机 HTTP 页面，不接受局域网地址或伪装成本机的域名。
func IsBrowserOrigin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") &&
		u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && loopbackHost(u.Hostname())
}

// BrowserOrigins 让不同端口的本机开发网页复用桌面后台，仍然只开放回环地址。
func BrowserOrigins() []string {
	return []string{
		"http://localhost", "https://localhost", "http://localhost:*", "https://localhost:*",
		"http://127.0.0.1", "https://127.0.0.1", "http://127.0.0.1:*", "https://127.0.0.1:*",
		"http://[::1]", "https://[::1]", "http://[::1]:*", "https://[::1]:*",
	}
}

func RequireAddress(address string) error {
	if !Enabled() {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil || !loopbackHost(host) {
		return fmt.Errorf("本机版本已禁止外部网络连接，只允许回环地址")
	}
	return nil
}

func RequireURL(raw string) error {
	if !Enabled() {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || !loopbackHost(u.Hostname()) || u.User != nil {
		return fmt.Errorf("本机版本只能连接本机服务")
	}
	switch u.Scheme {
	case "http", "https", "ws", "wss":
		return nil
	default:
		return fmt.Errorf("本机服务地址使用了不支持的协议")
	}
}

func DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if err := RequireAddress(address); err != nil {
		return nil, err
	}
	if Enabled() {
		host, port, _ := net.SplitHostPort(address)
		if host == "localhost" {
			address = net.JoinHostPort("127.0.0.1", port)
		}
	}
	return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, address)
}

// 数据库和缓存不使用 HTTP，启动前单独检查，防止沿用以前的远程配置。
func ValidateLocalServices() error {
	for _, key := range []string{"DATABASE_URL", "DATABASE_REPLICA_URL", "REDIS_URL"} {
		raw := strings.TrimSpace(os.Getenv(key))
		if raw == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil || !loopbackHost(u.Hostname()) {
			return fmt.Errorf("%s 必须指向本机服务", key)
		}
	}
	return nil
}

// 只限制由 Multica 管理的 Git 操作，不把限制注入独立 AI 工具。
func GitEnv(env []string) []string {
	if !Enabled() {
		return env
	}
	result := make([]string, 0, len(env)+1)
	for _, value := range env {
		if !strings.HasPrefix(value, "GIT_ALLOW_PROTOCOL=") {
			result = append(result, value)
		}
	}
	return append(result, "GIT_ALLOW_PROTOCOL=file")
}
