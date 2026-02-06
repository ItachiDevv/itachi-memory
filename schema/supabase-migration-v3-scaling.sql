-- Itachi Memory System - V3 Scaling Foundation
-- Adds project_registry for multi-project support
-- Updates claim_next_task with optional project filter
--
-- Run AFTER supabase-migration-elizaos.sql

-- ============================================================
-- 1. Central project registry
-- ============================================================
CREATE TABLE IF NOT EXISTS project_registry (
    name text PRIMARY KEY,
    display_name text,
    repo_url text,
    default_branch text DEFAULT 'main',
    telegram_chat_id bigint,
    orchestrator_affinity text,
    deployment_mode text DEFAULT 'shared' CHECK (deployment_mode IN ('shared', 'dedicated')),
    agent_model text DEFAULT 'sonnet',
    max_budget_usd numeric(6,2) DEFAULT 5.00,
    tags text[] DEFAULT '{}',
    metadata jsonb DEFAULT '{}',
    active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- ============================================================
-- 2. Migrate existing repos into registry
-- ============================================================
INSERT INTO project_registry (name, repo_url)
SELECT name, repo_url FROM repos
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 3. Updated claim_next_task with optional project filter
-- ============================================================
DROP FUNCTION IF EXISTS claim_next_task(text, numeric);
DROP FUNCTION IF EXISTS claim_next_task(text, numeric, text);

CREATE OR REPLACE FUNCTION claim_next_task(
    p_orchestrator_id text,
    p_max_budget numeric DEFAULT NULL,
    p_project text DEFAULT NULL
) RETURNS SETOF itachi_tasks LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    UPDATE itachi_tasks
    SET
        status = 'claimed',
        orchestrator_id = p_orchestrator_id,
        started_at = now()
    WHERE id = (
        SELECT id FROM itachi_tasks
        WHERE status = 'queued'
            AND (p_max_budget IS NULL OR max_budget_usd <= p_max_budget)
            AND (p_project IS NULL OR project = p_project)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END; $$;
