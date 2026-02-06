-- Itachi Memory System - ElizaOS Migration
-- Run this in Supabase SQL Editor BEFORE deploying ElizaOS.
--
-- ElizaOS creates its own `memories` table via Drizzle migrations.
-- This migration renames our existing table to avoid collisions.
--
-- Rollback: ALTER TABLE itachi_memories RENAME TO memories;
--           Then recreate original match_memories function.

-- ============================================================
-- 1. Rename existing memories table
-- ============================================================
ALTER TABLE memories RENAME TO itachi_memories;

-- ============================================================
-- 2. Rename indexes
-- ============================================================
ALTER INDEX IF EXISTS idx_memories_project_created RENAME TO idx_itachi_memories_project_created;
ALTER INDEX IF EXISTS idx_memories_category RENAME TO idx_itachi_memories_category;

-- ============================================================
-- 3. Recreate match_memories to reference itachi_memories
-- ============================================================
CREATE OR REPLACE FUNCTION match_memories(
    query_embedding vector(1536),
    match_project text DEFAULT NULL,
    match_category text DEFAULT NULL,
    match_branch text DEFAULT NULL,
    match_limit int DEFAULT 5
)
RETURNS TABLE (
    id uuid,
    project text,
    category text,
    content text,
    summary text,
    files text[],
    branch text,
    task_id uuid,
    created_at timestamptz,
    similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.id,
        m.project,
        m.category,
        m.content,
        m.summary,
        m.files,
        m.branch,
        m.task_id,
        m.created_at,
        1 - (m.embedding <=> query_embedding) AS similarity
    FROM itachi_memories m
    WHERE
        (match_project IS NULL OR m.project = match_project)
        AND (match_category IS NULL OR m.category = match_category)
        AND (match_branch IS NULL OR m.branch = match_branch)
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_limit;
END; $$;

-- ============================================================
-- 4. Update foreign key on itachi_memories.task_id (if it exists)
-- ============================================================
-- FK constraints were renamed with the table; no action needed.

-- ============================================================
-- 5. Rename existing tasks table
-- ============================================================
-- ElizaOS also creates its own `tasks` table with different columns.
ALTER TABLE tasks RENAME TO itachi_tasks;

-- Rename tasks indexes
ALTER INDEX IF EXISTS idx_tasks_queue RENAME TO idx_itachi_tasks_queue;
ALTER INDEX IF EXISTS idx_tasks_user RENAME TO idx_itachi_tasks_user;
ALTER INDEX IF EXISTS tasks_pkey RENAME TO itachi_tasks_pkey;

-- ============================================================
-- 6. Add notified_at column to itachi_tasks (for deduplication)
-- ============================================================
ALTER TABLE itachi_tasks ADD COLUMN IF NOT EXISTS notified_at timestamptz;

-- ============================================================
-- 7. Drop old claim_next_task overloads and recreate for itachi_tasks
-- ============================================================
DROP FUNCTION IF EXISTS claim_next_task(text, numeric);
CREATE OR REPLACE FUNCTION claim_next_task(
    p_orchestrator_id text,
    p_max_budget numeric DEFAULT NULL
)
RETURNS SETOF itachi_tasks
LANGUAGE plpgsql AS $$
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
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
END; $$;

-- ============================================================
-- 8. Create repos table if not exists (some deployments may not have it)
-- ============================================================
CREATE TABLE IF NOT EXISTS repos (
    name text PRIMARY KEY,
    repo_url text,
    created_at timestamptz DEFAULT now()
);

-- ============================================================
-- Done! ElizaOS Drizzle migrations can now create their own
-- `memories` and `tasks` tables without conflicts.
-- Itachi custom data lives in `itachi_memories` and `itachi_tasks`.
-- ============================================================
