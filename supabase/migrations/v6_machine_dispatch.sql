-- v6: Machine dispatch support
-- Adds p_machine_id to claim_next_task and makes it SECURITY DEFINER

CREATE OR REPLACE FUNCTION claim_next_task(
    p_orchestrator_id text,
    p_max_budget numeric DEFAULT NULL,
    p_project text DEFAULT NULL,
    p_machine_id text DEFAULT NULL
) RETURNS SETOF itachi_tasks LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    UPDATE itachi_tasks
    SET status = 'claimed', orchestrator_id = p_orchestrator_id, started_at = now()
    WHERE id = (
        SELECT id FROM itachi_tasks
        WHERE status = 'queued'
            AND (p_max_budget IS NULL OR max_budget_usd <= p_max_budget)
            AND (p_project IS NULL OR project = p_project)
            AND (p_machine_id IS NULL OR assigned_machine IS NULL OR assigned_machine = p_machine_id)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    ) RETURNING *;
END; $$;
