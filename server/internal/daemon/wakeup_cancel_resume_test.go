package daemon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestTerminalWakeupRechecksActiveTaskBeforePoll(t *testing.T) {
	for _, status := range []string{"cancelled", "running"} {
		t.Run(status, func(t *testing.T) {
			checked := make(chan struct{}, 1)
			peerDone := make(chan struct{})
			upgrader := websocket.Upgrader{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/status") {
					_, _ = w.Write([]byte(`{"status":"` + status + `"}`))
					select {
					case checked <- struct{}{}:
					default:
					}
					return
				}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				// 后台在运行结束或取消后发出的提示没有 task_id。
				_ = conn.WriteJSON(protocol.Message{Type: protocol.EventDaemonTaskAvailable, Payload: marshalRaw(protocol.TaskAvailablePayload{RuntimeID: "runtime-1"})})
				<-peerDone
			}))
			t.Cleanup(srv.Close)
			t.Cleanup(func() { close(peerDone) })
			d := New(Config{ServerBaseURL: srv.URL}, testTaskPhaseLogger())
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			cancelled := d.watchTaskCancellation(ctx, "old-chat-run", time.Hour, d.logger)
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			readerDone := make(chan error, 1)
			go func() { readerDone <- d.readTaskWakeupMessages(conn, make(chan taskWakeup, 1)) }()
			t.Cleanup(func() {
				_ = conn.Close()
				select {
				case <-readerDone:
				case <-time.After(time.Second):
					t.Error("通知连接没有退出")
				}
			})
			select {
			case <-checked:
			case <-time.After(time.Second):
				t.Fatal("收到结束提示后仍在等待下一次定时轮询")
			}
			if status == "cancelled" {
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("已取消的聊天运行没有及时停止")
				}
			} else {
				select {
				case <-cancelled:
					t.Fatal("其他运行释放容量时，不应误停仍在执行的聊天")
				default:
				}
			}
		})
	}
}
