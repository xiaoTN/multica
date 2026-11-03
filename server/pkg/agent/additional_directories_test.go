package agent

import (
	"encoding/json"
	"log/slog"
	"reflect"
	"strings"
	"testing"
)

func TestAdditionalDirectoriesLaunchArguments(t *testing.T) {
	opts := ExecOptions{Cwd: "/work/frontend", AdditionalDirs: []string{"/work/backend with spaces", "/work/共享"}}
	claude := buildClaudeArgs(opts, slog.Default())
	var got []string
	for i := 0; i+1 < len(claude); i++ {
		if claude[i] == "--add-dir" {
			got = append(got, claude[i+1])
		}
	}
	if !reflect.DeepEqual(got, opts.AdditionalDirs) {
		t.Fatalf("Claude 没有收到额外仓库：%v", claude)
	}
	codex := buildCodexArgs(opts, slog.Default())
	const prefix = "sandbox_workspace_write.writable_roots="
	var roots []string
	for _, arg := range codex {
		if strings.HasPrefix(arg, prefix) {
			if err := json.Unmarshal([]byte(strings.TrimPrefix(arg, prefix)), &roots); err != nil {
				t.Fatal(err)
			}
		}
	}
	want := append([]string{opts.Cwd}, opts.AdditionalDirs...)
	if !reflect.DeepEqual(roots, want) {
		t.Fatalf("Codex 可写目录 = %v，期望 %v", roots, want)
	}
}
