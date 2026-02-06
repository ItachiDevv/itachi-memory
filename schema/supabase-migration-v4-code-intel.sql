-- Itachi Memory System - V4 Deep Code Intelligence
-- Adds session_edits, session_summaries, cross_project_insights
-- Plus vector search + cleanup RPCs
--
-- Run AFTER supabase-migration-v3-scaling.sql
-- Requires: pgvector extension (CREATE EXTENSION IF NOT EXISTS vector;)

-- ============================================================
-- 1. Session edits — per-edit data from hooks
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
-- 2. Session summaries — enriched by LLM after session ends
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
-- 3. Cross-project insights — weekly correlator output
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
-- 4. Vector search across sessions
-- ============================================================
CREATE OR REPLACE FUNCTION match_sessions(
    query_embedding vector(1536),
    match_project text DEFAULT NULL,
    match_limit int DEFAULT 5
) RETURNS TABLE (
    id uuid,
    session_id text,
    project text,
    summary text,
    files_changed text[],
    key_decisions text[],
    patterns_used text[],
    duration_ms integer,
    created_at timestamptz,
    similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id, s.session_id, s.project, s.summary,
        s.files_changed, s.key_decisions, s.patterns_used,
        s.duration_ms, s.created_at,
        1 - (s.embedding <=> query_embedding) AS similarity
    FROM session_summaries s
    WHERE
        (match_project IS NULL OR s.project = match_project)
        AND s.embedding IS NOT NULL
    ORDER BY s.embedding <=> query_embedding
    LIMIT match_limit;
END; $$;

-- ============================================================
-- 5. Cleanup function — called monthly by worker
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_intelligence_data() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Archive old session edits (90 days)
    DELETE FROM session_edits WHERE created_at < now() - interval '90 days';

    -- Archive old pattern observations (90 days)
    DELETE FROM itachi_memories
    WHERE category = 'pattern_observation'
      AND created_at < now() - interval '90 days';

    -- Archive low-confidence cross-project insights (180 days)
    DELETE FROM cross_project_insights
    WHERE created_at < now() - interval '180 days'
      AND confidence < 0.3;
END; $$;
