package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestRunTaskMultipleRepositories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("测试执行器使用 POSIX shell")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
	for _, mode := range []string{"in_place", "worktree"} {
		t.Run(mode, func(t *testing.T) {
			first, second := createDaemonTestRepo(t), createDaemonTestRepo(t)
			fakeBin := filepath.Join(t.TempDir(), "claude")
			writeTestExecutable(t, fakeBin, []byte(`#!/bin/sh
set -eu
extra=''
for arg in "$@"; do
 if [ "$extra" = next ]; then printf 'backend' > "$arg/multi-task.txt"; extra=''; fi
 if [ "$arg" = --add-dir ]; then extra=next; fi
done
printf 'frontend' > multi-task.txt
IFS= read -r _
printf '%s\n' '{"type":"system","session_id":"session-multi"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"session-multi","result":"done"}'
`))
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
			defer srv.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			d := &Daemon{
				client: NewClient(srv.URL), logger: logger, localPathLocks: NewLocalPathLocker(),
				workspaces: make(map[string]*workspaceState), activeEnvRoots: make(map[string]int),
				cfg: Config{DaemonID: "multi-daemon", WorkspacesRoot: t.TempDir(), AgentTimeout: 5 * time.Second, ServerBaseURL: srv.URL, Agents: map[string]AgentEntry{"claude": {Path: fakeBin}}},
			}
			task := Task{ID: "multi-task-first", WorkspaceID: "multi-ws", ProjectID: "multi-project", IssueID: "multi-issue", IssueIdentifier: "MULTI-1", RuntimeID: "multi-runtime", AgentID: "multi-agent", AuthToken: "mat_test", Agent: &AgentData{ID: "multi-agent", Name: "multi-agent"}, localDirectoryLease: &localDirectoryTaskLease{}}
			for _, path := range []string{first, second} {
				ref, err := json.Marshal(localDirectoryRef{LocalPath: path, DaemonID: d.cfg.DaemonID, ExecutionMode: mode})
				if err != nil {
					t.Fatal(err)
				}
				task.ProjectResources = append(task.ProjectResources, ProjectResourceData{ResourceType: localDirectoryResourceType, ResourceRef: ref})
			}
			release, abort := d.acquireLocalDirectoryLockIfNeeded(context.Background(), task, logger)
			if abort {
				t.Fatal("无法占用任务目录")
			}
			if release != nil {
				defer release()
			}
			result, err := d.runTask(context.Background(), task, "claude", 0, logger)
			if err != nil || result.Status != "completed" {
				t.Fatalf("多仓库任务没有完成：%+v %v", result, err)
			}
			for i, repo := range []string{first, second} {
				if mode == "in_place" {
					data, err := os.ReadFile(filepath.Join(repo, "multi-task.txt"))
					if err != nil || len(data) == 0 {
						t.Fatalf("仓库 %d 没收到任务改动：%s %v", i, data, err)
					}
				} else {
					if _, err := os.Stat(filepath.Join(repo, "multi-task.txt")); !os.IsNotExist(err) {
						t.Fatalf("隔离任务改动了原仓库 %d", i)
					}
					out, err := exec.Command("git", "-C", repo, "log", "--all", "--format=%H", "--", "multi-task.txt").CombinedOutput()
					if err != nil || len(out) == 0 {
						t.Fatalf("仓库 %d 没有交付分支：%s %v", i, out, err)
					}
				}
			}
		})
	}
}
