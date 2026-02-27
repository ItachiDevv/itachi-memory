-- Add outcome-aware filtering to memory search RPCs
-- Allows filtering memories by metadata->>'outcome' (success/partial/failure)
-- Default NULL = no filter (backward compatible)

-- 1. Update match_memories to support outcome filtering
CREATE OR REPLACE FUNCTION match_memories(
    query_embedding vector(1536),
    match_project text DEFAULT NULL,
    match_category text DEFAULT NULL,
    match_branch text DEFAULT NULL,
    match_metadata_outcome text DEFAULT NULL,
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
        AND (match_metadata_outcome IS NULL OR m.metadata->>'outcome' = match_metadata_outcome)
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_limit;
END; $$;

-- 2. Update match_memories_hybrid to support outcome filtering
CREATE OR REPLACE FUNCTION match_memories_hybrid(
    query_embedding vector(1536),
    query_text text DEFAULT '',
    match_project text DEFAULT NULL,
    match_category text DEFAULT NULL,
    match_branch text DEFAULT NULL,
    match_metadata_outcome text DEFAULT NULL,
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
          AND (match_metadata_outcome IS NULL OR m.metadata->>'outcome' = match_metadata_outcome)
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
          AND (match_metadata_outcome IS NULL OR m.metadata->>'outcome' = match_metadata_outcome)
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

-- 3. Index for outcome metadata filtering performance
CREATE INDEX IF NOT EXISTS idx_itachi_memories_outcome
ON itachi_memories ((metadata->>'outcome'));

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
