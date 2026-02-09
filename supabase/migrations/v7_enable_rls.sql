-- v7: Enable RLS on ALL tables
-- service_role key bypasses RLS automatically.
-- anon/authenticated get full access via policies (app-level auth via ITACHI_API_KEY).

-- ============ Enable RLS on all tables ============
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE central_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE components ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_project_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE itachi_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE itachi_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_server_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE worlds ENABLE ROW LEVEL SECURITY;

-- ============ Policies for ElizaOS core tables ============
-- ElizaOS uses service_role (bypasses RLS). These policies allow
-- anon/authenticated access for the orchestrator which may use anon key.

CREATE POLICY "allow_all_agents" ON agents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_cache" ON cache FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_central_messages" ON central_messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_channel_participants" ON channel_participants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_channels" ON channels FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_components" ON components FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_embeddings" ON embeddings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_entities" ON entities FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_logs" ON logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_memories" ON memories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_message_server_agents" ON message_server_agents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_message_servers" ON message_servers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_participants" ON participants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_relationships" ON relationships FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_rooms" ON rooms FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_servers" ON servers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_tasks" ON tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_worlds" ON worlds FOR ALL USING (true) WITH CHECK (true);

-- ============ Policies for Itachi tables ============
CREATE POLICY "allow_all_cross_project_insights" ON cross_project_insights FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_itachi_memories" ON itachi_memories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_itachi_tasks" ON itachi_tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_machine_registry" ON machine_registry FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_project_registry" ON project_registry FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_repos" ON repos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_session_edits" ON session_edits FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_session_summaries" ON session_summaries FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_sync_files" ON sync_files FOR ALL USING (true) WITH CHECK (true);
