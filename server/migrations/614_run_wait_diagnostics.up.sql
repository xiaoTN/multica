ALTER TABLE agent_task_queue
    ADD COLUMN wait_diagnostic jsonb,
    ADD COLUMN wait_history jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_runtime ADD COLUMN daemon_capacity jsonb;

-- Keep diagnostics coupled to the lifecycle even when an older daemon or a
-- cancellation/recovery path writes the status directly.
CREATE FUNCTION record_run_wait_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb; signature jsonb; old_signature jsonb;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.wait_diagnostic := NULL;
        IF NEW.status = 'dispatched' THEN
            NEW.wait_diagnostic := jsonb_build_object('code', 'awaiting_daemon', 'scope', 'daemon', 'phase', 'dispatched');
        ELSIF NEW.status = 'waiting_local_directory' THEN
            NEW.wait_diagnostic := jsonb_build_object('code', 'local_directory_busy', 'scope', 'local_directory', 'phase', 'resource_wait');
        END IF;
    END IF;
    signature := NEW.wait_diagnostic - 'evaluated_at' - 'since' - 'occupied' - 'limit';
    old_signature := OLD.wait_diagnostic - 'evaluated_at' - 'since' - 'occupied' - 'limit';
    IF signature IS DISTINCT FROM old_signature THEN
        IF NEW.wait_diagnostic IS NOT NULL THEN
            NEW.wait_diagnostic := NEW.wait_diagnostic || jsonb_build_object('since', now(), 'evaluated_at', now());
        END IF;
        previous := jsonb_build_object('at', now(), 'status', NEW.status, 'diagnostic', NEW.wait_diagnostic);
        SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]') INTO NEW.wait_history
        FROM jsonb_array_elements(OLD.wait_history || jsonb_build_array(previous)) WITH ORDINALITY
        WHERE ordinality > jsonb_array_length(OLD.wait_history) - 31;
    ELSIF NEW.wait_diagnostic IS NOT NULL THEN
        NEW.wait_diagnostic := NEW.wait_diagnostic || jsonb_build_object('since', OLD.wait_diagnostic->'since');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER run_wait_diagnostic_lifecycle BEFORE UPDATE OF status, wait_diagnostic ON agent_task_queue
    FOR EACH ROW EXECUTE FUNCTION record_run_wait_diagnostic();
