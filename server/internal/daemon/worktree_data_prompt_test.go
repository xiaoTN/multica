package daemon

import (
	"strings"
	"testing"
)

func TestWorktreeDataPromptProvidesAllRepositoryLocations(t *testing.T) {
	task := Task{IssueID: "issue-1"}
	if prompt := BuildPrompt(task, "claude"); strings.Contains(prompt, "长期私有数据") {
		t.Fatal("没有临时工作树的任务不应收到归档目录说明")
	}
	paths := []string{"/repo-a/.git/multica-data/issue-1", "/repo-b/.git/multica-data/issue-1"}
	prompt := BuildPrompt(task, "claude", WithWorktreeDataDirs(paths))
	for _, want := range append(paths, "工作树是临时目录", "archives/<运行标识>/files/", "manifest.json", "账本和回执") {
		if !strings.Contains(prompt, want) {
			t.Errorf("任务说明缺少长期数据的交接信息：%s", want)
		}
	}
}

func TestWorktreePromptCombinesDeliveryRulesWithPersistentData(t *testing.T) {
	for _, allLeftovers := range []bool{false, true} {
		name := "committed work only"
		want := "If you commit, only your commits are delivered"
		if allLeftovers {
			name = "pending user snapshot"
			want = "even if you have made commits of your own"
		}
		t.Run(name, func(t *testing.T) {
			opts := []PromptOption{
				WithWorktreeBranch("agent/test/ihome-34", "baseline"),
				WithWorktreeDataDirs([]string{"/repo/.git/multica-data/session"}),
			}
			if allLeftovers {
				opts = append(opts, WithWorktreeCommitsAllLeftovers())
			}
			out := BuildPrompt(Task{IssueID: "issue-1"}, "claude", opts...)
			for _, required := range []string{
				"agent/test/ihome-34", "baseline", want,
				"/repo/.git/multica-data/session", "archives/<运行标识>/files/", "manifest.json",
			} {
				if !strings.Contains(out, required) {
					t.Errorf("combined worktree prompt missing %q", required)
				}
			}
		})
	}
}
