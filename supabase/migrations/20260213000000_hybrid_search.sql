-- Hybrid search: FTS column + GIN index + match_memories_hybrid RPC
-- Additive migration — does NOT modify match_memories

-- 1. Add tsvector generated column for full-text search
ALTER TABLE itachi_memories
ADD COLUMN IF NOT EXISTS search_vector tsvector
GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(content, ''))
) STORED;

-- 2. GIN index for fast FTS queries
CREATE INDEX IF NOT EXISTS idx_itachi_memories_search_vector
ON itachi_memories USING GIN (search_vector);

-- 3. Hybrid RPC: combines vector similarity + full-text search
CREATE OR REPLACE FUNCTION match_memories_hybrid(
    query_embedding vector(1536),
    query_text text DEFAULT '',
    match_project text DEFAULT NULL,
    match_category text DEFAULT NULL,
    match_branch text DEFAULT NULL,
    match_limit int DEFAULT 5,
    vector_weight float DEFAULT 0.7,
    text_weight float DEFAULT 0.3
) RETURNS TABLE (
    id uuid, project text, category text, content text,
    summary text, files text[], branch text, task_id uuid,
    metadata jsonb, created_at timestamptz, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    WITH vec AS (
        SELECT m.id,
               1 - (m.embedding <=> query_embedding) AS vec_score
        FROM itachi_memories m
        WHERE (match_project IS NULL OR m.project = match_project)
          AND (match_category IS NULL OR m.category = match_category)
          AND (match_branch IS NULL OR m.branch = match_branch)
        ORDER BY m.embedding <=> query_embedding
        LIMIT match_limit * 3
    ),
    fts AS (
        SELECT m.id,
               ts_rank_cd(m.search_vector, websearch_to_tsquery('english', query_text)) AS fts_score
        FROM itachi_memories m
        WHERE query_text IS NOT NULL
          AND query_text <> ''
          AND m.search_vector @@ websearch_to_tsquery('english', query_text)
          AND (match_project IS NULL OR m.project = match_project)
          AND (match_category IS NULL OR m.category = match_category)
          AND (match_branch IS NULL OR m.branch = match_branch)
        LIMIT match_limit * 3
    ),
    combined AS (
        SELECT COALESCE(v.id, f.id) AS combined_id,
               vector_weight * COALESCE(v.vec_score, 0) +
               text_weight * COALESCE(f.fts_score, 0) AS combined_score
        FROM vec v
        FULL OUTER JOIN fts f ON v.id = f.id
    )
    SELECT m.id, m.project, m.category, m.content, m.summary,
           m.files, m.branch, m.task_id, m.metadata, m.created_at,
           c.combined_score AS similarity
    FROM combined c
    JOIN itachi_memories m ON m.id = c.combined_id
    ORDER BY c.combined_score DESC
    LIMIT match_limit;
END; $$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
