package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// SteerQueuedChatTask transfers an unscheduled input to the exact running turn.
// Its message keeps its ID; neither the running task nor its prompt is cancelled.
func (s *TaskService) SteerQueuedChatTask(ctx context.Context, session db.ChatSession, queuedID, targetID pgtype.UUID) (*DirectChatSendResult, error) {
	var out DirectChatSendResult
	var retired db.AgentTaskQueue
	err := s.runInTx(ctx, func(q *db.Queries) error {
		if _, err := q.LockChatSessionForRuntimeBind(ctx, session.ID); err != nil {
			return err
		}
		current, err := q.GetChatSession(ctx, session.ID)
		if err != nil {
			return err
		}
		if current.Status != "active" {
			return ErrChatSessionArchived
		}
		agent, err := q.GetAgentForClaimUpdate(ctx, session.AgentID)
		if err != nil {
			return err
		}
		if agent.ArchivedAt.Valid {
			return ErrChatTaskAgentArchived
		}
		target, err := q.LockChatSupplementTarget(ctx, db.LockChatSupplementTargetParams{
			TaskID: targetID, ChatSessionID: session.ID, AgentID: agent.ID, WorkspaceID: session.WorkspaceID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrChatSteerUnavailable
		}
		if err != nil {
			return err
		}
		queued, err := q.GetAgentTask(ctx, queuedID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrChatSteerUnavailable
		}
		if err != nil {
			return err
		}
		if queued.Status != "queued" || queued.ChatSessionID != session.ID || queued.AgentID != agent.ID || queued.ChatInputTaskID != queued.ID {
			return ErrChatSteerUnavailable
		}
		messages, err := q.ListChatInputMessages(ctx, queued.ID)
		if err != nil {
			return err
		}
		if len(messages) != 1 {
			return ErrChatSteerUnavailable
		}
		attachments, err := q.ListAttachmentsByChatMessage(ctx, db.ListAttachmentsByChatMessageParams{ChatMessageID: messages[0].ID, WorkspaceID: session.WorkspaceID})
		if err != nil {
			return err
		}
		if len(attachments) != 0 {
			return ErrChatSteerUnavailable
		}
		msg, err := q.MoveQueuedChatMessageToRun(ctx, db.MoveQueuedChatMessageToRunParams{ID: messages[0].ID, QueuedTaskID: queued.ID, TargetTaskID: target.ID})
		if err != nil {
			return err
		}
		if err := q.CreateChatTaskSupplement(ctx, db.CreateChatTaskSupplementParams{MessageID: msg.ID, TaskID: target.ID, ChatSessionID: session.ID, AuthorID: session.CreatorID}); err != nil {
			return err
		}
		retired, err = q.CancelQueuedAgentTask(ctx, db.CancelQueuedAgentTaskParams{ID: queued.ID, ChatSessionID: session.ID, CancelledByType: pgtype.Text{String: "member", Valid: true}, CancelledByID: session.CreatorID})
		if err != nil {
			return err
		}
		out.Task, out.Message, out.Steered = target, msg, true
		return q.TouchChatSession(ctx, session.ID)
	})
	if err != nil {
		return nil, err
	}
	s.BroadcastCancelledTasks(ctx, util.UUIDToString(session.WorkspaceID), []db.AgentTaskQueue{retired})
	return &out, nil
}
