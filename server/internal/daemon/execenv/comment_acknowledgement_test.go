package execenv

import (
	"strings"
	"testing"
)

func TestIssueBriefAllowsAcknowledgementWithoutLosingWrittenResults(t *testing.T) {
	for name, ctx := range map[string]TaskContextForEnv{
		"assignment": {IssueID: "issue-1"},
		"comment":    {IssueID: "issue-1", TriggerCommentID: "comment-1"},
		"workflow":   {IssueID: "issue-1", HasProjectWorkflow: true},
		"squad":      {IssueID: "issue-1", IsSquadLeader: true},
	} {
		t.Run(name, func(t *testing.T) {
			brief := buildMetaSkillContent("codex", ctx)
			for _, want := range []string{
				"Comment acknowledgement policy",
				"new comment turns and human messages added during a run",
				"multica issue comment reaction add <comment-id>",
				"repeated add is idempotent",
				"finish with empty final output",
				"Explicit questions, requirement changes needing explanation, failures and blockers need a written reply",
				"post its substantive final result",
				"acknowledgement alone leaves issue status unchanged",
				"Delivery/read receipts only record transport",
				"Brief replies to follow-up human messages are allowed",
			} {
				if !strings.Contains(brief, want) {
					t.Errorf("brief missing %q", want)
				}
			}
		})
	}
	for _, ctx := range []TaskContextForEnv{{ChatSessionID: "chat-1"}, {QuickCreatePrompt: "create an issue"}, {AutopilotID: "auto-1", AutopilotRunID: "run-1"}} {
		if strings.Contains(buildMetaSkillContent("codex", ctx), "Comment acknowledgement policy") {
			t.Fatal("issue acknowledgement rule leaked into another delivery channel")
		}
	}
}

func TestReplyTargetsAllowReactionOnlyAcknowledgement(t *testing.T) {
	for _, leader := range []bool{false, true} {
		single := BuildCommentReplyInstructions("codex", "issue-1", "comment-1", leader)
		for _, want := range []string{"reaction add comment-1", "only when a written reply is needed"} {
			if !strings.Contains(single, want) {
				t.Errorf("single reply (leader=%v) missing %q", leader, want)
			}
		}
		multiple := BuildMultiThreadCommentReplyInstructions("issue-1", []ThreadReplyTarget{{ThreadID: "t1", ParentID: "comment-1"}, {ThreadID: "t2", ParentID: "comment-2"}}, leader)
		if !strings.Contains(multiple, "simple human confirmation may instead receive a reaction on its exact comment ID") {
			t.Errorf("multiple reply targets (leader=%v) require duplicate written acknowledgements", leader)
		}
	}
}
