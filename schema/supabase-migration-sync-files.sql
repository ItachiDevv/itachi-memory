-- Itachi Memory System - Sync Files Migration
-- Encrypted file sync across machines (AES-256-GCM + PBKDF2)
-- Run this in the Supabase SQL editor.

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

-- Atomic upsert with auto-incrementing version
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
