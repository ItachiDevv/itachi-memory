-- Migration v7: Enable Row Level Security on ALL tables
--
-- ElizaOS connects via SUPABASE_SERVICE_ROLE_KEY which bypasses RLS.
-- This migration blocks all direct access via the anon key.
-- No anon policies are created — all public/client-side access is denied.
--
-- Run in Supabase SQL Editor or via psql.

-- ============================================================
-- Itachi custom tables
-- ============================================================

ALTER TABLE IF EXISTS itachi_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS itachi_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cross_project_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS project_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS machine_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS session_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS session_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sync_files ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- ElizaOS core tables
-- ============================================================

ALTER TABLE IF EXISTS agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS channel_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS components ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS message_server_info ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS message_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS central_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS message_server_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS worlds ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Verify: list tables with RLS status
-- ============================================================

SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
