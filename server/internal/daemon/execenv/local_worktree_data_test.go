package execenv

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalWorktreeFinalizePreservesIgnoredPrivateData(t *testing.T) {
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, ".gitignore"), "/.multica/home-photo/\n*.private\n")
	gitRun(t, repo, "add", ".gitignore")
	gitRun(t, repo, "commit", "-m", "忽略私有任务数据")
	wt := prepareTurn(t, repo, "IHOME-3", turnOneTask)
	private := filepath.Join(wt.Path, ".multica", "home-photo")
	if err := os.MkdirAll(filepath.Join(private, "live-state"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(private, "live-state", "ledger.sqlite"), "历史调用账本")
	writeFile(t, filepath.Join(private, "frozen.json"), "固定样本清单")
	writeFile(t, filepath.Join(wt.Path, "带 空格.private"), "私有原始数据")
	writeFile(t, filepath.Join(wt.Path, "result.txt"), "测试报告")
	finalizeOK(t, wt)
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatalf("临时工作目录没有清理：%v", err)
	}
	kept := map[string]bool{}
	dataRoot := filepath.Join(repo, ".git", "multica-data")
	_ = filepath.WalkDir(dataRoot, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			data, err := os.ReadFile(path)
			if err == nil {
				kept[string(data)] = true
			}
		}
		return nil
	})
	for _, want := range []string{"历史调用账本", "固定样本清单", "私有原始数据"} {
		if !kept[want] {
			t.Errorf("临时目录清理后丢失了后续要用的数据：%s", want)
		}
	}
	if tracked := gitRun(t, repo, "ls-tree", "-r", "--name-only", wt.Branch); strings.Contains(tracked, "home-photo") || strings.Contains(tracked, ".private") {
		t.Fatalf("私有数据意外进入了 Git：%s", tracked)
	}
}

func TestLocalWorktreeDataSurvivesFollowingTurnsAndHelperRoundTrip(t *testing.T) {
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, ".gitignore"), "/private/\n")
	gitRun(t, repo, "add", ".gitignore")
	gitRun(t, repo, "commit", "-m", "忽略私有数据")
	first := prepareTurn(t, repo, "IHOME-3", turnOneTask)
	writeFile(t, filepath.Join(first.Path, "private", "ledger.sqlite"), "第一轮账本")
	wire, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	var helperResult LocalWorktree
	if err := json.Unmarshal(wire, &helperResult); err != nil {
		t.Fatal(err)
	}
	finalizeOK(t, &helperResult)
	second := prepareTurn(t, repo, "IHOME-3", turnTwoTask)
	if first.DataDir != second.DataDir || helperResult.DataDir != first.DataDir {
		t.Fatal("下一轮或准备进程丢失了长期数据入口")
	}
	writeFile(t, filepath.Join(second.Path, "private", "ledger.sqlite"), "第二轮账本")
	finalizeOK(t, second)
	archives, err := filepath.Glob(filepath.Join(first.DataDir, "archives", "*", "files", "private", "ledger.sqlite"))
	if err != nil || len(archives) != 2 {
		t.Fatalf("两轮数据没有分别保存：%v，%v", archives, err)
	}
	if info, err := os.Stat(first.DataDir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("长期目录的权限不正确：%v，%v", info, err)
	}
	otherOwner := testBranchOwner
	otherOwner.AgentID = "另一个智能体"
	third, err := prepareTurnAs(t, repo, "IHOME-3", turnThreeTask, otherOwner)
	if err != nil {
		t.Fatal(err)
	}
	if third.DataDir != first.DataDir {
		t.Fatal("同一任务换智能体后找不到之前的长期数据")
	}
	finalizeOK(t, third)
}

func TestLocalWorktreeDataArchiveFailureKeepsOriginalWorktree(t *testing.T) {
	repo := newTestRepo(t)
	writeFile(t, filepath.Join(repo, ".gitignore"), "/private/\n")
	gitRun(t, repo, "add", ".gitignore")
	gitRun(t, repo, "commit", "-m", "忽略私有数据")
	wt := prepareTurn(t, repo, "IHOME-3", turnOneTask)
	ledger := filepath.Join(wt.Path, "private", "ledger.sqlite")
	writeFile(t, ledger, "不能丢失的账本")
	wt.DataDir = filepath.Join(t.TempDir(), "不可用的归档目标")
	writeFile(t, wt.DataDir, "这是文件，不是目录")
	outcome, err := wt.Finalize(worktreeTestLogger())
	if err == nil || outcome.PreservedPath != wt.Path {
		t.Fatalf("保存失败后仍然清理了目录：%+v，%v", outcome, err)
	}
	if data, err := os.ReadFile(ledger); err != nil || string(data) != "不能丢失的账本" {
		t.Fatalf("保存失败后原始账本丢失：%q，%v", data, err)
	}
	if list := gitRun(t, repo, "worktree", "list", "--porcelain"); !strings.Contains(list, wt.Path) {
		t.Fatal("保存失败后原工作树没有保留注册")
	}
}
