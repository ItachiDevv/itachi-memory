-- Itachi Memory System - V6 Machine Registry + Task Dispatch
-- Adds machine_registry table and assigned_machine to itachi_tasks
-- Enables ElizaOS to intelligently route tasks to specific orchestrator machines
--
-- Run AFTER supabase-migration-v5-telegram-topics.sql

-- ============================================================
-- 1. Machine Registry table
-- ============================================================
CREATE TABLE IF NOT EXISTS machine_registry (
  machine_id text PRIMARY KEY,
  display_name text,
  projects text[] DEFAULT '{}',
  max_concurrent int DEFAULT 2,
  active_tasks int DEFAULT 0,
  os text,
  specs jsonb DEFAULT '{}',
  last_heartbeat timestamptz DEFAULT now(),
  registered_at timestamptz DEFAULT now(),
  status text DEFAULT 'online' CHECK (status IN ('online', 'offline', 'busy'))
);

COMMENT ON TABLE machine_registry IS 'Orchestrator machines that poll for and execute tasks';
COMMENT ON COLUMN machine_registry.projects IS 'Array of project names this machine has cloned locally';
COMMENT ON COLUMN machine_registry.max_concurrent IS 'Maximum concurrent tasks this machine can run';
COMMENT ON COLUMN machine_registry.active_tasks IS 'Current number of running tasks (updated via heartbeat)';

-- ============================================================
-- 2. Add assigned_machine column to itachi_tasks
-- ============================================================
ALTER TABLE itachi_tasks
  ADD COLUMN IF NOT EXISTS assigned_machine text REFERENCES machine_registry(machine_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_itachi_tasks_assigned_machine
  ON itachi_tasks (assigned_machine)
  WHERE assigned_machine IS NOT NULL;

COMMENT ON COLUMN itachi_tasks.assigned_machine IS 'Machine ID assigned by ElizaOS dispatcher (NULL = unassigned)';

-- ============================================================
-- 3. Update claim_next_task to support machine filtering
-- ============================================================
CREATE OR REPLACE FUNCTION claim_next_task(
  p_orchestrator_id text,
  p_machine_id text DEFAULT NULL,
  p_project text DEFAULT NULL
)
RETURNS SETOF itachi_tasks AS $$
BEGIN
  RETURN QUERY
  UPDATE itachi_tasks SET
    status = 'claimed',
    orchestrator_id = p_orchestrator_id,
    started_at = now()
  WHERE id = (
    SELECT id FROM itachi_tasks
    WHERE status = 'queued'
      AND (p_machine_id IS NULL OR assigned_machine IS NULL OR assigned_machine = p_machine_id)
      AND (p_project IS NULL OR project = p_project)
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;
