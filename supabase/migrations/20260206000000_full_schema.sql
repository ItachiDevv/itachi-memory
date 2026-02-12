-- Itachi Memory System — Full Schema (Fresh DB)
-- Consolidated from: init, v2, elizaos, sync-files, v3-scaling, v4-code-intel
-- Creates all tables with final names (itachi_memories, itachi_tasks) directly.

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 1. itachi_memories — core memory storage with embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS itachi_memories (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    project text NOT NULL DEFAULT 'default',
    category text NOT NULL DEFAULT 'code_change',
    content text NOT NULL,
    summary text NOT NULL,
    files text[] DEFAULT '{}',
    branch text DEFAULT 'main',
    task_id uuid,
    metadata jsonb DEFAULT '{}',
    embedding vector(1536),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_itachi_memories_project_created
    ON itachi_memories (project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_itachi_memories_category
    ON itachi_memories (category);

-- ============================================================
-- 2. itachi_tasks — task orchestration queue
-- ============================================================
CREATE TABLE IF NOT EXISTS itachi_tasks (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    description text NOT NULL,
    project text NOT NULL,
    repo_url text,
    branch text DEFAULT 'main',
    target_branch text,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','claimed','running','completed','failed','cancelled','timeout')),
    priority int DEFAULT 0,
    model text DEFAULT 'sonnet',
    max_budget_usd numeric(6,2) DEFAULT 5.00,
    session_id text,
    result_summary text,
    result_json jsonb,
    error_message text,
    files_changed text[] DEFAULT '{}',
    pr_url text,
    telegram_chat_id bigint NOT NULL,
    telegram_user_id bigint NOT NULL,
    orchestrator_id text,
    workspace_path text,
    notified_at timestamptz,
    created_at timestamptz DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_itachi_tasks_queue
    ON itachi_tasks (status, priority DESC, created_at)
    WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_itachi_tasks_user
    ON itachi_tasks (telegram_user_id, created_at DESC);

-- Add FK from memories to tasks
ALTER TABLE itachi_memories
    ADD CONSTRAINT fk_itachi_memories_task_id
    FOREIGN KEY (task_id) REFERENCES itachi_tasks(id);

-- ============================================================
-- 3. repos — legacy repo tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS repos (
    name text PRIMARY KEY,
    repo_url text,
    created_at timestamptz DEFAULT now()
);

-- ============================================================
-- 4. sync_files — encrypted file sync (AES-256-GCM + PBKDF2)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_files (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    repo_name text NOT NULL,
    file_path text NOT NULL,
    encrypted_data text NOT NULL,
    salt text NOT NULL,
    content_hash text NOT NULL,
    version integer NOT NULL DEFAULT 1,
    updated_by text NOT NULL,
    updated_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now(),
    UNIQUE (repo_name, file_path)
);

CREATE INDEX IF NOT EXISTS idx_sync_files_repo ON sync_files (repo_name);

-- ============================================================
-- 5. project_registry — multi-project config
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

-- Seed from repos if any exist
INSERT INTO project_registry (name, repo_url)
SELECT name, repo_url FROM repos
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 6. session_edits — per-edit data from hooks
-- ============================================================
CREATE TABLE IF NOT EXISTS session_edits (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id text NOT NULL,
    project text NOT NULL,
    file_path text NOT NULL,
    edit_type text DEFAULT 'modify' CHECK (edit_type IN ('create', 'modify', 'delete')),
    language text,
    diff_content text,
    lines_added integer DEFAULT 0,
    lines_removed integer DEFAULT 0,
    tool_name text,
    branch text DEFAULT 'main',
    task_id uuid REFERENCES itachi_tasks(id),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_edits_project ON session_edits (project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_edits_session ON session_edits (session_id);

-- ============================================================
-- 7. session_summaries — LLM-enriched session data
-- ============================================================
CREATE TABLE IF NOT EXISTS session_summaries (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id text UNIQUE NOT NULL,
    project text NOT NULL,
    task_id uuid REFERENCES itachi_tasks(id),
    started_at timestamptz,
    ended_at timestamptz,
    duration_ms integer,
    exit_reason text,
    files_changed text[] DEFAULT '{}',
    total_lines_added integer DEFAULT 0,
    total_lines_removed integer DEFAULT 0,
    tools_used jsonb DEFAULT '{}',
    summary text,
    key_decisions text[],
    patterns_used text[],
    branch text DEFAULT 'main',
    orchestrator_id text,
    embedding vector(1536),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries (project, created_at DESC);

-- ============================================================
-- 8. cross_project_insights — weekly correlator output
-- ============================================================
CREATE TABLE IF NOT EXISTS cross_project_insights (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    insight_type text NOT NULL CHECK (insight_type IN ('pattern', 'dependency', 'style', 'convention', 'library', 'antipattern')),
    projects text[] NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    confidence float DEFAULT 0.5,
    evidence jsonb DEFAULT '[]',
    embedding vector(1536),
    active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
);

-- ============================================================
-- RPCs
-- ============================================================

-- Vector search across memories
CREATE OR REPLACE FUNCTION match_memories(
    query_embedding vector(1536),
    match_project text DEFAULT NULL,
    match_category text DEFAULT NULL,
    match_branch text DEFAULT NULL,
    match_limit int DEFAULT 5
) RETURNS TABLE (
    id uuid, project text, category text, content text,
    summary text, files text[], branch text, task_id uuid,
    metadata jsonb, created_at timestamptz, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT m.id, m.project, m.category, m.content, m.summary,
        m.files, m.branch, m.task_id, m.metadata, m.created_at,
        1 - (m.embedding <=> query_embedding) AS similarity
    FROM itachi_memories m
    WHERE (match_project IS NULL OR m.project = match_project)
        AND (match_category IS NULL OR m.category = match_category)
        AND (match_branch IS NULL OR m.branch = match_branch)
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_limit;
END; $$;

-- Vector search across sessions
CREATE OR REPLACE FUNCTION match_sessions(
    query_embedding vector(1536),
    match_project text DEFAULT NULL,
    match_limit int DEFAULT 5
) RETURNS TABLE (
    id uuid, session_id text, project text, summary text,
    files_changed text[], key_decisions text[], patterns_used text[],
    duration_ms integer, created_at timestamptz, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT s.id, s.session_id, s.project, s.summary,
        s.files_changed, s.key_decisions, s.patterns_used,
        s.duration_ms, s.created_at,
        1 - (s.embedding <=> query_embedding) AS similarity
    FROM session_summaries s
    WHERE (match_project IS NULL OR s.project = match_project)
        AND s.embedding IS NOT NULL
    ORDER BY s.embedding <=> query_embedding
    LIMIT match_limit;
END; $$;

-- Atomic task claiming with optional project filter
CREATE OR REPLACE FUNCTION claim_next_task(
    p_orchestrator_id text,
    p_max_budget numeric DEFAULT NULL,
    p_project text DEFAULT NULL
) RETURNS SETOF itachi_tasks LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    UPDATE itachi_tasks
    SET status = 'claimed', orchestrator_id = p_orchestrator_id, started_at = now()
    WHERE id = (
        SELECT id FROM itachi_tasks
        WHERE status = 'queued'
            AND (p_max_budget IS NULL OR max_budget_usd <= p_max_budget)
            AND (p_project IS NULL OR project = p_project)
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    ) RETURNING *;
END; $$;

-- Atomic sync file upsert with auto-incrementing version
CREATE OR REPLACE FUNCTION upsert_sync_file(
    p_repo_name text, p_file_path text, p_encrypted_data text,
    p_salt text, p_content_hash text, p_updated_by text
) RETURNS sync_files LANGUAGE plpgsql AS $$
DECLARE result sync_files; cur_ver integer;
BEGIN
    SELECT version INTO cur_ver FROM sync_files
    WHERE repo_name = p_repo_name AND file_path = p_file_path FOR UPDATE;

    IF cur_ver IS NOT NULL THEN
        UPDATE sync_files SET encrypted_data = p_encrypted_data, salt = p_salt,
            content_hash = p_content_hash, version = cur_ver + 1,
            updated_by = p_updated_by, updated_at = now()
        WHERE repo_name = p_repo_name AND file_path = p_file_path RETURNING * INTO result;
    ELSE
        INSERT INTO sync_files (repo_name, file_path, encrypted_data, salt, content_hash, version, updated_by)
        VALUES (p_repo_name, p_file_path, p_encrypted_data, p_salt, p_content_hash, 1, p_updated_by)
        RETURNING * INTO result;
    END IF;
    RETURN result;
END; $$;

-- Monthly cleanup of stale intelligence data
CREATE OR REPLACE FUNCTION cleanup_intelligence_data() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM session_edits WHERE created_at < now() - interval '90 days';
    DELETE FROM itachi_memories WHERE category = 'pattern_observation'
        AND created_at < now() - interval '90 days';
    DELETE FROM cross_project_insights WHERE created_at < now() - interval '180 days'
        AND confidence < 0.3;
END; $$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
