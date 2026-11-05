package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIssueCommentReaction(t *testing.T) {
	for _, action := range []string{"add", "remove"} {
		t.Run(action, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				wantMethod := http.MethodPost
				if action == "remove" {
					wantMethod = http.MethodDelete
				}
				if r.Method != wantMethod || r.URL.Path != "/api/comments/comment-1/reactions" {
					t.Errorf("request = %s %s", r.Method, r.URL.Path)
				}
				for header, want := range map[string]string{"Authorization": "Bearer mat_fixture", "X-Workspace-ID": "ws-1", "X-Agent-ID": "agent-1", "X-Task-ID": "task-1"} {
					if got := r.Header.Get(header); got != want {
						t.Errorf("%s = %q, want %q", header, got, want)
					}
				}
				var body map[string]string
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["emoji"] != "👌" {
					t.Errorf("body = %v, err = %v", body, err)
				}
				if action == "remove" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(w).Encode(map[string]string{"id": "reaction-1", "actor_type": "agent", "actor_id": "agent-1", "emoji": "👌"})
			}))
			defer server.Close()
			t.Setenv("MULTICA_SERVER_URL", server.URL)
			t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
			t.Setenv("MULTICA_TOKEN", "mat_fixture")
			t.Setenv("MULTICA_AGENT_ID", "agent-1")
			t.Setenv("MULTICA_TASK_ID", "task-1")
			for range 2 {
				cmd := newIssueCommentReactionCmd()
				cmd.SetArgs([]string{action, "comment-1", "--emoji", "👌"})
				out, err := captureStdout(t, cmd.Execute)
				if err != nil {
					t.Fatal(err)
				}
				var result map[string]any
				if err := json.Unmarshal([]byte(out), &result); err != nil {
					t.Fatalf("stdout is not JSON: %q: %v", out, err)
				}
				if action == "add" && result["actor_type"] != "agent" {
					t.Fatalf("reaction lost agent identity: %v", result)
				}
			}
			if requests != 2 {
				t.Fatalf("retry made %d requests, want 2 independent %s calls", requests, action)
			}
		})
	}
}

func TestIssueCommentReactionRejectsInvalidInputAndSurfacesErrors(t *testing.T) {
	for _, args := range [][]string{{"add"}, {"add", "a", "b", "--emoji", "👌"}, {"add", "a"}, {"add", "a", "--emoji", " "}, {"add", "a", "--emoji", "👌", "--output", "yaml"}} {
		cmd := newIssueCommentReactionCmd()
		cmd.SilenceUsage, cmd.SilenceErrors = true, true
		cmd.SetArgs(args)
		if err := cmd.Execute(); err == nil {
			t.Fatalf("accepted invalid arguments %v", args)
		}
	}
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":"rejected"}`))
			}))
			defer server.Close()
			t.Setenv("MULTICA_SERVER_URL", server.URL)
			t.Setenv("MULTICA_TOKEN", "mat_fixture")
			cmd := newIssueCommentReactionCmd()
			cmd.SilenceUsage, cmd.SilenceErrors = true, true
			cmd.SetArgs([]string{"add", "comment-1", "--emoji", "👌"})
			out, err := captureStdout(t, cmd.Execute)
			if err == nil || !strings.Contains(err.Error(), "rejected") || out != "" {
				t.Fatalf("out=%q err=%v", out, err)
			}
		})
	}
}
