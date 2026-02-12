-- Transcript indexer: track per-file indexing progress

CREATE TABLE IF NOT EXISTS itachi_transcript_offsets (
    file_path text PRIMARY KEY,
    byte_offset bigint NOT NULL DEFAULT 0,
    lines_indexed int NOT NULL DEFAULT 0,
    last_indexed timestamptz DEFAULT now()
);

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
