package daemon

import (
	"fmt"
	"strings"
	"testing"
)

func TestBuildPromptRefreshesAuthenticationOnResumedChat(t *testing.T) {
	// 同一会话连续续接时，每轮都必须说明自己的身份，不能继承上一轮的鉴权结论。
	for turn := 1; turn <= 3; turn++ {
		task := Task{
			ID:             fmt.Sprintf("chat-run-%d", turn),
			ChatSessionID:  "same-chat",
			PriorSessionID: "same-provider-session",
			AuthToken:      fmt.Sprintf("mat_test_run_%d", turn),
			ChatMessage:    "继续查询任务",
		}
		prompt := BuildPrompt(task, "codex")
		for _, want := range []string{task.ID, "MULTICA_TOKEN", "上一轮", "本轮", "只读", "成员凭证"} {
			if !strings.Contains(prompt, want) {
				t.Errorf("第 %d 轮缺少续接身份说明 %q", turn, want)
			}
		}
		if strings.Contains(prompt, task.AuthToken) {
			t.Fatal("运行提示词泄露了身份凭证")
		}
		if turn > 1 && strings.Contains(prompt, fmt.Sprintf("chat-run-%d", turn-1)) {
			t.Fatal("新一轮仍携带上一轮的运行身份")
		}
	}
}

func TestBuildPromptDoesNotClaimCredentialsWhenMissing(t *testing.T) {
	prompt := BuildPrompt(Task{ID: "missing-auth", ChatSessionID: "chat"}, "codex")
	if strings.Contains(prompt, "[本轮运行身份]") {
		t.Fatal("没有凭证时不应声称已提供本轮身份")
	}
}
