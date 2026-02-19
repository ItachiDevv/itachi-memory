-- Schema parity for machine dispatch + interactive task status.
-- Makes existing databases consistent with current runtime expectations.

-- ============================================================
-- 1) machine_registry table + required columns
-- ============================================================
CREATE TABLE IF NOT EXISTS machine_registry (
    machine_id text PRIMARY KEY,
    display_name text,
    projects text[] DEFAULT '{}',
    max_concurrent int DEFAULT 2,
    active_tasks int DEFAULT 0,
    os text,
    specs jsonb DEFAULT '{}',
    engine_priority text[] DEFAULT ARRAY['claude','codex','gemini'],
    health_url text,
    last_heartbeat timestamptz DEFAULT now(),
    registered_at timestamptz DEFAULT now(),
    status text DEFAULT 'online' CHECK (status IN ('online', 'offline', 'busy'))
);

ALTER TABLE machine_registry
    ADD COLUMN IF NOT EXISTS engine_priority text[] DEFAULT ARRAY['claude','codex','gemini'],
    ADD COLUMN IF NOT EXISTS health_url text;

CREATE INDEX IF NOT EXISTS idx_machine_registry_status_heartbeat
    ON machine_registry (status, last_heartbeat DESC);

-- ============================================================
-- 2) itachi_tasks.machine assignment + status compatibility
-- ============================================================
ALTER TABLE itachi_tasks
    ADD COLUMN IF NOT EXISTS assigned_machine text;

CREATE INDEX IF NOT EXISTS idx_itachi_tasks_assigned_machine
    ON itachi_tasks (assigned_machine)
    WHERE assigned_machine IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_itachi_tasks_assigned_machine'
    ) THEN
        ALTER TABLE itachi_tasks
            ADD CONSTRAINT fk_itachi_tasks_assigned_machine
            FOREIGN KEY (assigned_machine) REFERENCES machine_registry(machine_id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- Ensure waiting_input is an allowed status (used by orchestrator interactive turns).
DO $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'itachi_tasks'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP
        EXECUTE format('ALTER TABLE itachi_tasks DROP CONSTRAINT %I', c.conname);
    END LOOP;

    ALTER TABLE itachi_tasks
        ADD CONSTRAINT itachi_tasks_status_check
        CHECK (status IN ('queued','claimed','running','waiting_input','completed','failed','cancelled','timeout'));
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END $$;

-- ============================================================
-- 3) claim_next_task RPC alignment (named args used by orchestrator)
-- ============================================================
DROP FUNCTION IF EXISTS claim_next_task(text,numeric,text);
DROP FUNCTION IF EXISTS claim_next_task(text,text,text);
DROP FUNCTION IF EXISTS claim_next_task(text,numeric,text,text);
DROP FUNCTION IF EXISTS claim_next_task(text,text,text,numeric);

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
            AND (p_machine_id IS NULL OR assigned_machine IS NULL OR assigned_machine = p_machine_id)
            AND (p_project IS NULL OR project = p_project)
            AND (p_max_budget IS NULL OR max_budget_usd <= p_max_budget)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    ) RETURNING *;
END; $$;

NOTIFY pgrst, 'reload schema';
