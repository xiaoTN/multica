package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// RunWaitDiagnostic contains only allowlisted admission evidence. It never
// carries daemon-supplied text, paths, credentials or private chat identifiers.
type RunWaitDiagnostic struct {
	Code           string    `json:"code"`
	Phase          string    `json:"phase"`
	Scope          string    `json:"scope"`
	Occupied       *int64    `json:"occupied,omitempty"`
	Limit          *int64    `json:"limit,omitempty"`
	BlockingTaskID string    `json:"blocking_task_id,omitempty"`
	Since          time.Time `json:"since,omitzero"`
	EvaluatedAt    time.Time `json:"evaluated_at,omitzero"`
	Message        string    `json:"message"`
}

func RunWaitForTask(task db.AgentTaskQueue) *RunWaitDiagnostic {
	phase := ""
	switch task.Status {
	case "queued":
		phase = "queued"
	case "dispatched":
		phase = "dispatched"
	case "waiting_local_directory":
		phase = "resource_wait"
	default:
		return nil
	}
	diagnostic := RunWaitDiagnostic{Code: "unknown", Phase: phase, Scope: "run", Since: task.CreatedAt.Time}
	if len(task.WaitDiagnostic) > 0 {
		_ = json.Unmarshal(task.WaitDiagnostic, &diagnostic)
	}
	diagnostic.Message = RunWaitMessage(diagnostic.Code)
	return &diagnostic
}

func RunWaitMessage(code string) string {
	switch code {
	case "agent_concurrency":
		return "该智能体并发已满"
	case "runtime_concurrency":
		return "运行时并发已满"
	case "daemon_capacity":
		return "守护进程执行槽已满"
	case "daemon_updating":
		return "守护进程正在准备更新，暂停领取"
	case "previous_run":
		return "等待上一条运行结束"
	case "runtime_offline":
		return "运行时离线或心跳已过期"
	case "runtime_unbound":
		return "尚未绑定运行时"
	case "runtime_rebound":
		return "运行时绑定已变更，等待调度处理"
	case "wakeup_inactive":
		return "唤醒规则已失效，等待调度处理"
	case "awaiting_claim":
		return "服务端排队中，等待领取；阻塞原因尚未上报"
	case "awaiting_daemon":
		return "已分派，等待守护进程确认领取"
	case "preparing_session":
		return "已领取，正在准备智能体会话"
	case "local_directory_busy":
		return "等待本地目录释放"
	case "worktree_snapshot_busy":
		return "等待目录释放以准备工作树快照"
	default:
		return "等待原因尚未上报"
	}
}

// RefreshRunWaits is also used by authorized reads: an offline runtime cannot
// poll to explain itself. These are admission predicates, not UI heuristics.
func (s *TaskService) RefreshRunWaits(ctx context.Context, tasks []db.AgentTaskQueue) []db.AgentTaskQueue {
	ids := make([]pgtype.UUID, 0, len(tasks))
	for _, t := range tasks {
		if t.Status == "queued" {
			ids = append(ids, t.ID)
		}
	}
	if len(ids) == 0 {
		return tasks
	}
	rows, err := s.Queries.ObserveQueuedRunWaits(ctx, db.ObserveQueuedRunWaitsParams{TaskIds: ids, RuntimeStaleSecs: RuntimeClaimFreshnessSeconds})
	if err != nil {
		slog.Warn("observe queued run waits", "error", err)
		return tasks
	}
	byID := make(map[pgtype.UUID]db.AgentTaskQueue, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	for i, t := range tasks {
		if row, ok := byID[t.ID]; ok {
			s.publishRunWaitChange(ctx, t, row)
			tasks[i] = row
		}
	}
	return tasks
}

func (s *TaskService) observeAgentRunWaits(ctx context.Context, agentID pgtype.UUID) {
	rows, err := s.Queries.ObserveQueuedRunWaits(ctx, db.ObserveQueuedRunWaitsParams{AgentID: agentID, RuntimeStaleSecs: RuntimeClaimFreshnessSeconds, TaskIds: []pgtype.UUID{}})
	if err != nil {
		slog.Warn("observe claim run waits", "error", err)
		return
	}
	// A task-specific invalidation carries no blocker identifiers. Readers use
	// their existing authorized endpoint to resolve the fresh evidence.
	for _, row := range rows {
		s.broadcastTaskEvent(ctx, "task:wait_changed", row)
	}
}

func (s *TaskService) publishRunWaitChange(ctx context.Context, before, after db.AgentTaskQueue) {
	a, b := RunWaitForTask(before), RunWaitForTask(after)
	if a != nil && b != nil && a.Code == b.Code && a.Scope == b.Scope && a.Since.Equal(b.Since) && sameWaitCount(a.Occupied, b.Occupied) && sameWaitCount(a.Limit, b.Limit) {
		return
	}
	s.broadcastTaskEvent(ctx, "task:wait_changed", after)
}

func sameWaitCount(a, b *int64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

func (s *TaskService) SetRunPreparation(ctx context.Context, task db.AgentTaskQueue, code string) (db.AgentTaskQueue, error) {
	scope, phase := "daemon", "preparing"
	if code == "local_directory_busy" || code == "worktree_snapshot_busy" {
		scope, phase = "local_directory", "resource_wait"
	}
	data, _ := json.Marshal(map[string]any{"code": code, "phase": phase, "scope": scope, "evaluated_at": time.Now().UTC()})
	updated, err := s.Queries.SetRunPreparationDiagnostic(ctx, db.SetRunPreparationDiagnosticParams{TaskID: task.ID, RuntimeID: task.RuntimeID, DispatchedAt: task.DispatchedAt, Diagnostic: data})
	if err == nil {
		s.publishRunWaitChange(ctx, task, updated)
	}
	return updated, err
}
