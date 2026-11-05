package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func (h *Handler) applyChatDeliveryReceipts(ctx context.Context, sessionID pgtype.UUID, messages []ChatMessageResponse) {
	rows, err := h.Queries.ListChatTaskSupplements(ctx, sessionID)
	if err != nil {
		return
	}
	byID := make(map[string]db.ChatTaskSupplement, len(rows))
	for _, row := range rows {
		byID[uuidToString(row.MessageID)] = row
	}
	for i := range messages {
		if receipt, ok := byID[messages[i].ID]; ok {
			messages[i].DeliveryStatus = receipt.Status
			messages[i].DeliveryFailureReason = textToPtr(receipt.FailureReason)
			messages[i].DeliveredAt = timestampToPtr(receipt.DeliveredAt)
		}
	}
}

func (h *Handler) claimChatTaskSupplement(w http.ResponseWriter, r *http.Request, task db.AgentTaskQueue) {
	row, err := h.Queries.ClaimNextChatTaskSupplement(r.Context(), task.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to claim chat addition")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"message_id": uuidToString(row.MessageID), "content": row.Content,
		"author_type": "member", "author_name": row.AuthorName,
	})
}

func (h *Handler) ackChatTaskSupplement(w http.ResponseWriter, r *http.Request, task db.AgentTaskQueue) {
	messageID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "commentId"), "message id")
	if !ok {
		return
	}
	var req ackTaskSupplementRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	receipt, err := h.Queries.AckChatTaskSupplement(r.Context(), db.AckChatTaskSupplementParams{
		TaskID: task.ID, MessageID: messageID, Delivered: req.Delivered,
		FailureReason: stableTaskSupplementFailureReason(req.Error),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "chat addition cannot be acknowledged")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to acknowledge chat addition")
		return
	}
	// The ordinary message event invalidates both message projections. Receipt
	// reads remain authoritative even when an acknowledgement races completion.
	msg, err := h.Queries.GetChatMessage(r.Context(), messageID)
	if err == nil {
		session, err := h.Queries.GetChatSession(r.Context(), receipt.ChatSessionID)
		if err == nil {
			h.publishChat(protocol.EventChatMessage, uuidToString(session.WorkspaceID), "member", uuidToString(session.CreatorID), uuidToString(session.ID), protocol.ChatMessagePayload{
				ChatSessionID: uuidToString(session.ID), MessageID: uuidToString(msg.ID), Role: "user",
				Content: msg.Content, TaskID: uuidToString(task.ID), CreatedAt: timestampToString(msg.CreatedAt),
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": receipt.Status})
}
