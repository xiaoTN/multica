package handler

import (
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestAgentReactionPersistsAndRetriesWithoutToggling(t *testing.T) {
	issue := dbfx.Issue(t, "Agent acknowledgement")
	comment := dbfx.Comment(t, issue, "Received, local delivery only")
	other := dbfx.Comment(t, issue, "Another message")
	runtime := dbfx.Runtime(t, "fixture")
	agent := dbfx.Agent(t, "Acknowledging agent", runtime)
	task := dbfx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "running"})
	h := *testHandler
	h.Bus = events.New()
	var published []events.Event
	h.Bus.SubscribeAll(func(e events.Event) { published = append(published, e) })
	request := func(method string) *http.Request {
		r := withURLParam(newRequest(method, "/api/comments/"+comment+"/reactions", map[string]string{"emoji": "👌"}), "commentId", comment)
		r.Header.Set("X-Actor-Source", "task_token")
		r.Header.Set("X-Agent-ID", agent)
		r.Header.Set("X-Task-ID", task)
		return r
	}
	var first ReactionResponse
	for attempt := range 2 {
		var got ReactionResponse
		testutil.Call(t, h.AddReaction, request(http.MethodPost)).Want(http.StatusCreated).JSON(&got)
		if got.ActorType != "agent" || got.ActorID != agent || got.CommentID != comment {
			t.Fatalf("reaction identity or target = %+v", got)
		}
		if attempt == 0 {
			first = got
		} else if got.ID != first.ID {
			t.Fatalf("retry created a new reaction: %s != %s", got.ID, first.ID)
		}
	}
	if len(published) != 1 || published[0].Type != protocol.EventReactionAdded || published[0].ActorID != agent {
		t.Fatalf("events = %+v, want one reaction event as the agent", published)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM comment_reaction WHERE comment_id=$1", comment); n != 1 {
		t.Fatalf("persisted reactions = %d", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM comment_reaction WHERE comment_id=$1", other); n != 0 {
		t.Fatalf("another comment received %d reactions", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue); n != 1 {
		t.Fatalf("reaction queued new runs: %d", n)
	}
	// Reload through the same aggregate query used by comment responses.
	loaded := h.groupReactions(request(http.MethodGet), []pgtype.UUID{parseUUID(comment)})[comment]
	if len(loaded) != 1 || loaded[0].ID != first.ID || loaded[0].ActorID != agent {
		t.Fatalf("reloaded reactions = %+v", loaded)
	}
	for range 2 {
		testutil.Call(t, h.RemoveReaction, request(http.MethodDelete)).Want(http.StatusNoContent)
	}
	if len(published) != 2 || published[1].Type != protocol.EventReactionRemoved {
		t.Fatalf("removal retry published duplicate events: %+v", published)
	}
}
