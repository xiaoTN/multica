-- name: ObserveQueuedRunWaits :many
-- This is the admission service's diagnostic evaluation, in the same order
-- as slot-before-claim, claimTask and ClaimAgentTask. It never admits work.
-- Keep the serialization and freshness predicates aligned with ClaimAgentTask.
-- Materialize the sample once instead of inlining every predicate into both
-- the JSON projection and the change filter.
WITH observations AS MATERIALIZED (
    SELECT t.id,
        CASE
            WHEN r.id IS NULL THEN 'runtime_unbound'
            WHEN a.runtime_id IS DISTINCT FROM t.runtime_id THEN 'runtime_rebound'
            WHEN r.status <> 'online' OR COALESCE(r.last_seen_at, r.updated_at) < now() - make_interval(secs => @runtime_stale_secs::double precision) THEN 'runtime_offline'
            WHEN r.daemon_capacity->>'blocked' = 'true'
                AND (r.daemon_capacity->>'evaluated_at')::timestamptz > now() - interval '30 seconds' THEN COALESCE(r.daemon_capacity->>'reason', 'daemon_capacity')
            WHEN ac.occupied >= a.max_concurrent_tasks THEN 'agent_concurrency'
            WHEN r.max_concurrent_tasks IS NOT NULL AND rc.occupied >= r.max_concurrent_tasks THEN 'runtime_concurrency'
            WHEN t.context->>'wakeup_id' IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM issue_wakeup w WHERE w.id=(t.context->>'wakeup_id')::uuid AND w.disabled_at IS NULL AND w.revision=(t.context->>'wakeup_revision')::bigint
            ) THEN 'wakeup_inactive'
            WHEN blocker.id IS NOT NULL THEN 'previous_run'
            ELSE 'awaiting_claim'
        END AS code,
        t.issue_id, t.chat_session_id, ac.occupied AS agent_occupied, a.max_concurrent_tasks AS agent_limit,
        rc.occupied AS runtime_occupied, r.max_concurrent_tasks AS runtime_limit,
        r.daemon_capacity, blocker.id AS blocker_id
    FROM agent_task_queue t JOIN agent a ON a.id = t.agent_id
    LEFT JOIN agent_runtime r ON r.id = t.runtime_id
    CROSS JOIN LATERAL (SELECT count(*) AS occupied FROM agent_task_queue active WHERE active.agent_id=t.agent_id AND active.status IN ('dispatched','running','waiting_local_directory')) ac
    CROSS JOIN LATERAL (SELECT count(*) AS occupied FROM agent_task_queue active WHERE active.runtime_id=t.runtime_id AND active.status IN ('dispatched','running','waiting_local_directory')) rc
    LEFT JOIN LATERAL (
        SELECT active.id FROM agent_task_queue active
        WHERE active.agent_id=t.agent_id AND active.status IN ('dispatched','running','waiting_local_directory')
          AND ((t.issue_id IS NOT NULL AND active.issue_id=t.issue_id)
            OR (t.chat_session_id IS NOT NULL AND active.chat_session_id=t.chat_session_id)
            OR (t.issue_id IS NULL AND t.chat_session_id IS NULL AND t.autopilot_run_id IS NULL
              AND active.issue_id IS NULL AND active.chat_session_id IS NULL AND active.autopilot_run_id IS NULL))
        ORDER BY active.created_at, active.id LIMIT 1
    ) blocker ON true
    WHERE t.status='queued' AND (t.id=ANY(@task_ids::uuid[]) OR t.agent_id=sqlc.narg('agent_id')::uuid)
), diagnostics AS (
    SELECT id, jsonb_strip_nulls(jsonb_build_object(
        'code', code, 'phase', 'queued',
        'scope', CASE code WHEN 'agent_concurrency' THEN 'agent' WHEN 'daemon_capacity' THEN 'daemon' WHEN 'daemon_updating' THEN 'daemon'
            WHEN 'previous_run' THEN CASE WHEN issue_id IS NOT NULL THEN 'issue_agent' WHEN chat_session_id IS NOT NULL THEN 'chat_session' ELSE 'quick_create_agent' END
            ELSE 'runtime' END,
        'occupied', CASE code WHEN 'agent_concurrency' THEN agent_occupied WHEN 'runtime_concurrency' THEN runtime_occupied WHEN 'daemon_capacity' THEN (daemon_capacity->>'occupied')::bigint END,
        'limit', CASE code WHEN 'agent_concurrency' THEN agent_limit WHEN 'runtime_concurrency' THEN runtime_limit WHEN 'daemon_capacity' THEN (daemon_capacity->>'limit')::int END,
        -- Only same-issue runs are addressable without disclosing private chats.
        'blocking_task_id', CASE WHEN code='previous_run' AND issue_id IS NOT NULL THEN blocker_id END,
        'evaluated_at', now()
    )) AS diagnostic FROM observations
)
UPDATE agent_task_queue t SET wait_diagnostic=d.diagnostic
FROM diagnostics d WHERE t.id=d.id AND t.status='queued'
  AND ((t.wait_diagnostic - 'evaluated_at' - 'since') IS DISTINCT FROM (d.diagnostic - 'evaluated_at')
    OR (t.wait_diagnostic->>'evaluated_at')::timestamptz < now() - interval '15 seconds')
RETURNING t.*;

-- name: ReportDaemonCapacity :exec
UPDATE agent_runtime SET daemon_capacity = @capacity::jsonb
WHERE id=ANY(@runtime_ids::uuid[]);

-- name: ClearDaemonCapacityWait :exec
UPDATE agent_runtime SET daemon_capacity = daemon_capacity || jsonb_build_object('blocked',false,'evaluated_at',now())
WHERE id=ANY(@runtime_ids::uuid[]) AND daemon_capacity->>'blocked' = 'true';

-- name: SetRunPreparationDiagnostic :one
UPDATE agent_task_queue SET wait_diagnostic = @diagnostic::jsonb
WHERE id = @task_id AND status IN ('dispatched', 'waiting_local_directory')
  AND runtime_id = @runtime_id AND dispatched_at = @dispatched_at
RETURNING *;
