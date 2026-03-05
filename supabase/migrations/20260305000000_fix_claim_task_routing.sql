-- Fix claim_next_task: executors should only claim tasks explicitly assigned to them.
-- Previously, when assigned_machine was NULL any executor could grab the task,
-- bypassing the dispatcher's project-based routing.

DROP FUNCTION IF EXISTS claim_next_task(text, text, text, numeric);

CREATE OR REPLACE FUNCTION claim_next_task(
    p_orchestrator_id text,
    p_machine_id text DEFAULT NULL,
    p_project text DEFAULT NULL,
    p_max_budget numeric DEFAULT NULL
) RETURNS SETOF itachi_tasks LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    UPDATE itachi_tasks
    SET status = 'claimed', orchestrator_id = p_orchestrator_id, started_at = now()
    WHERE id = (
        SELECT id FROM itachi_tasks
        WHERE status = 'queued'
            AND (p_machine_id IS NULL OR assigned_machine = p_machine_id)
            AND (p_project IS NULL OR project = p_project)
            AND (p_max_budget IS NULL OR max_budget_usd <= p_max_budget)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    ) RETURNING *;
END; $$;

NOTIFY pgrst, 'reload schema';
