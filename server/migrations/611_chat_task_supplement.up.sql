ALTER TABLE task_supplement_capability ALTER COLUMN issue_id DROP NOT NULL;

CREATE TABLE chat_task_supplement (
    message_id UUID NOT NULL,
    task_id UUID NOT NULL,
    chat_session_id UUID NOT NULL,
    author_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
    failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
