package execenv

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPrepareMultipleRepositories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("此验收脚本使用 POSIX shell")
	}
	for _, modes := range [][2]string{{"in_place", "in_place"}, {"worktree", "worktree"}, {"in_place", "worktree"}, {"worktree", "in_place"}} {
		t.Run(strings.Join(modes[:], "+"), func(t *testing.T) {
			repos := []string{newTestRepo(t), newTestRepo(t)}
			params := PrepareParams{
				WorkspacesRoot: t.TempDir(), WorkspaceID: "multi-ws", TaskID: "11112222-3333-4444-5555-666677778888", AgentName: "J", Provider: "claude",
				Task:             TaskContextForEnv{ProjectID: "project-1", IssueID: "issue-1", AgentID: "agent-1"},
				LocalDirectories: []LocalDirectoryForEnv{{Path: repos[0], Label: "前端", ExecutionMode: modes[0]}, {Path: repos[1], Label: "后端", ExecutionMode: modes[1]}},
			}
			if modes[0] == "worktree" {
				params.LocalWorktree = &LocalWorktreeParams{LocalPath: repos[0]}
			} else {
				params.LocalWorkDir = repos[0]
			}
			env, err := Prepare(params, worktreeTestLogger())
			if err != nil {
				t.Fatal(err)
			}
			defer env.Cleanup(true)
			if len(env.LocalDirectories) != 2 || env.LocalDirectories[0].Path != env.WorkDir {
				t.Fatalf("仓库路径丢失：%+v", env.LocalDirectories)
			}
			ctx := params.Task
			ctx.LocalDirectories = env.LocalDirectories
			brief, err := InjectRuntimeConfig(env.WorkDir, "claude", ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, directory := range env.LocalDirectories {
				if !strings.Contains(brief, directory.Path) {
					t.Fatalf("任务说明没有包含仓库：%s", directory.Path)
				}
			}
			// 用测试创建的执行器读写两个仓库，不调用用户安装的 Agent。
			runner := filepath.Join(t.TempDir(), "fake-agent")
			writeFile(t, runner, "#!/bin/sh\nset -eu\nprintf 'frontend' > change.txt\nprintf 'backend' > \"$1/change.txt\"\ncat change.txt \"$1/change.txt\"\n")
			if err := os.Chmod(runner, 0o755); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(runner, env.LocalDirectories[1].Path)
			cmd.Dir = env.WorkDir
			out, err := cmd.CombinedOutput()
			if err != nil || string(out) != "frontendbackend" {
				t.Fatalf("跨仓库执行失败：%s %v", out, err)
			}
			if err := CleanupRuntimeConfig(env.WorkDir, "claude"); err != nil {
				t.Fatal(err)
			}
			if err := CleanupSidecars(env.RootDir); err != nil {
				t.Fatal(err)
			}
			worktrees := append([]*LocalWorktree(nil), env.AdditionalLocalWorktrees...)
			if env.LocalWorktree != nil {
				worktrees = append(worktrees, env.LocalWorktree)
			}
			for _, wt := range worktrees {
				outcome, err := wt.Finalize(worktreeTestLogger())
				if err != nil {
					t.Fatal(err)
				}
				if got := gitRun(t, wt.GitRoot, "show", outcome.Branch+":change.txt"); got == "" {
					t.Fatal("分支没有保留任务改动")
				}
				if files := gitRun(t, wt.GitRoot, "ls-tree", "-r", "--name-only", outcome.Branch); strings.Contains(files, "CLAUDE.md") || strings.Contains(files, ".multica/") {
					t.Fatalf("分支混入任务临时文件：%s", files)
				}
			}
			for i, repo := range repos {
				_, err := os.Stat(filepath.Join(repo, "change.txt"))
				if modes[i] == "worktree" && !os.IsNotExist(err) {
					t.Fatalf("隔离模式改动了原仓库 %d：%v", i, err)
				}
				if modes[i] == "in_place" && err != nil {
					t.Fatalf("直接编辑没有保存到原仓库 %d：%v", i, err)
				}
			}
		})
	}
}

func TestAdditionalRepositoryPreparationRollsBackOnFailure(t *testing.T) {
	primary, secondary := newTestRepo(t), newTestRepo(t)
	_, err := Prepare(PrepareParams{
		WorkspacesRoot: t.TempDir(), WorkspaceID: "multi-ws", TaskID: "11112222-3333-4444-5555-666677778888", AgentName: "J", LocalWorkDir: primary,
		LocalDirectories: []LocalDirectoryForEnv{{Path: primary}, {Path: secondary, ExecutionMode: "worktree"}, {Path: t.TempDir(), ExecutionMode: "worktree"}},
	}, worktreeTestLogger())
	if err == nil {
		t.Fatal("不是 Git 仓库的目录不应创建隔离分支")
	}
	if got := gitRun(t, secondary, "worktree", "list", "--porcelain"); strings.Count(got, "worktree ") != 1 {
		t.Fatalf("准备失败后遗留了额外工作区：%s", got)
	}
	if _, err := os.Stat(filepath.Join(primary, TaskContextMarkerRelPath)); !os.IsNotExist(err) {
		t.Fatalf("准备失败不应向原仓库写入任务文件：%v", err)
	}
}
