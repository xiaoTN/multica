-- name: LockChatSupplementTarget :one
SELECT t.* FROM agent_task_queue t
JOIN task_supplement_capability cap ON cap.task_id = t.id
WHERE t.id = @task_id AND t.chat_session_id = @chat_session_id
  AND t.agent_id = @agent_id AND t.status = 'running'
  AND cap.capability = 'task-supplement-v1' AND cap.workspace_id = @workspace_id
FOR UPDATE OF t;

-- name: CreateChatTaskSupplement :exec
INSERT INTO chat_task_supplement (message_id, task_id, chat_session_id, author_id, status)
VALUES (@message_id, @task_id, @chat_session_id, @author_id, 'pending');

-- name: MoveQueuedChatMessageToRun :one
UPDATE chat_message SET task_id = @target_task_id
WHERE id = @id AND task_id = @queued_task_id AND role = 'user'
RETURNING *;

-- name: ClaimNextChatTaskSupplement :one
WITH next AS MATERIALIZED (
    SELECT s.message_id FROM chat_task_supplement s
    JOIN agent_task_queue t ON t.id = s.task_id
    WHERE s.task_id = @task_id AND s.status = 'pending' AND t.status = 'running'
    ORDER BY s.created_at, s.message_id
    FOR UPDATE OF s SKIP LOCKED LIMIT 1
), claimed AS (
    UPDATE chat_task_supplement s SET status = 'delivering', attempt_count = attempt_count + 1
    FROM next WHERE s.message_id = next.message_id RETURNING s.*
)
SELECT claimed.*, m.content, COALESCE(NULLIF(btrim(u.name), ''), 'a user')::text AS author_name
FROM claimed JOIN chat_message m ON m.id = claimed.message_id
JOIN "user" u ON u.id = claimed.author_id;

-- name: AckChatTaskSupplement :one
WITH task AS MATERIALIZED (
    SELECT id FROM agent_task_queue WHERE id = @task_id FOR UPDATE
)
UPDATE chat_task_supplement s
SET status = CASE WHEN @delivered::boolean THEN 'delivered' ELSE 'failed' END,
    failure_reason = CASE WHEN @delivered::boolean THEN NULL ELSE @failure_reason::text END,
    delivered_at = CASE WHEN @delivered::boolean THEN COALESCE(s.delivered_at, now()) ELSE NULL END
FROM task WHERE s.task_id = task.id AND s.message_id = @message_id
  AND (s.status = 'delivering' OR (@delivered::boolean AND
       (s.status = 'delivered' OR (s.status = 'failed' AND s.failure_reason = 'turn_ended' AND s.attempt_count > 0))))
RETURNING s.*;

-- name: ListChatTaskSupplements :many
SELECT * FROM chat_task_supplement WHERE chat_session_id = @chat_session_id;

-- name: SettleTerminalChatTaskSupplements :exec
UPDATE chat_task_supplement s SET status = 'failed', failure_reason = 'turn_ended'
FROM agent_task_queue t WHERE s.task_id = t.id AND t.id = ANY(@task_ids::uuid[])
  AND t.status IN ('completed', 'failed', 'cancelled') AND s.status IN ('pending', 'delivering');

-- name: DeleteChatTaskSupplementsBySession :exec
DELETE FROM chat_task_supplement WHERE chat_session_id = @chat_session_id;
