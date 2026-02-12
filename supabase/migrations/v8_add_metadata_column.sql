-- v8: Add metadata column to itachi_memories
-- Fixes: "column itachi_memories.metadata does not exist"
-- The code already references metadata but the column was never created.

ALTER TABLE itachi_memories ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

-- Must DROP first because return type changed (added metadata column)
DROP FUNCTION IF EXISTS match_memories(vector,text,text,text,integer);

-- Recreate match_memories RPC with metadata in result set
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

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
