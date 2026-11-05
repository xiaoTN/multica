DROP TRIGGER IF EXISTS run_wait_diagnostic_lifecycle ON agent_task_queue;
DROP FUNCTION IF EXISTS record_run_wait_diagnostic();
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS wait_diagnostic, DROP COLUMN IF EXISTS wait_history;
ALTER TABLE agent_runtime DROP COLUMN IF EXISTS daemon_capacity;
