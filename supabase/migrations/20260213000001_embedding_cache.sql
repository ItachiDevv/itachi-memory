-- Embedding cache: avoid redundant API calls for identical text

CREATE TABLE IF NOT EXISTS itachi_embedding_cache (
    content_hash text PRIMARY KEY,
    embedding vector(1536) NOT NULL,
    model_id text NOT NULL DEFAULT 'text-embedding',
    created_at timestamptz DEFAULT now(),
    last_used timestamptz DEFAULT now()
);

-- Index for future cleanup of stale entries
CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used
ON itachi_embedding_cache (last_used);

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
