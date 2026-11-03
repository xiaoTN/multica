package handler

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// LocalSession 只由本机版本注册，为桌面应用自动准备本地身份和默认工作区。
func (h *Handler) LocalSession(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		writeError(w, http.StatusForbidden, "只能从本机打开应用")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "null" {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") ||
			(u.Hostname() != "localhost" && (net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback())) {
			writeError(w, http.StatusForbidden, "只能从本机应用访问")
			return
		}
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "本机数据库暂时不可用")
		return
	}
	defer tx.Rollback(r.Context())
	fail := func(err error) {
		slog.Error("准备本地工作区失败", "error", err)
		writeError(w, http.StatusInternalServerError, "无法准备本地工作区，请重试")
	}
	// 多个窗口同时首次打开时，串行准备用户和工作区，避免重复创建。
	if _, err := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(771306)"); err != nil {
		fail(err)
		return
	}
	q := h.Queries.WithTx(tx)
	user, err := q.GetLocalUser(r.Context())
	if errors.Is(err, pgx.ErrNoRows) {
		user, err = q.CreateUser(r.Context(), db.CreateUserParams{
			Name: "本地用户", Email: "local@agentteam.local",
		})
	}
	if err != nil {
		fail(err)
		return
	}
	workspaces, err := q.ListWorkspaces(r.Context(), user.ID)
	if err != nil {
		fail(err)
		return
	}
	if len(workspaces) == 0 {
		ws, err := q.CreateWorkspace(r.Context(), db.CreateWorkspaceParams{
			Name: "我的工作区", Slug: fmt.Sprintf("local-%s", uuidToString(user.ID)), IssuePrefix: "TEAM",
		})
		if err != nil {
			fail(err)
			return
		}
		if _, err := q.CreateMember(r.Context(), db.CreateMemberParams{
			WorkspaceID: ws.ID, UserID: user.ID, Role: "owner",
		}); err != nil {
			fail(err)
			return
		}
		if err := issuestatus.Ensure(r.Context(), q, ws.ID); err != nil {
			fail(err)
			return
		}
	}
	user, err = q.PrepareLocalUser(r.Context(), user.ID)
	if err != nil {
		fail(err)
		return
	}
	token, err := h.issueJWT(user)
	if err != nil {
		fail(err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, LoginResponse{Token: token, User: h.userToResponse(user)})
}
