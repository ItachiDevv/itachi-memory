-- Upgrade itachi_reminders to support scheduled actions (not just text reminders)
ALTER TABLE itachi_reminders
  ADD COLUMN IF NOT EXISTS action_type text DEFAULT 'message'
    CHECK (action_type IN ('message', 'close_done', 'close_failed', 'sync_repos', 'recall', 'custom')),
  ADD COLUMN IF NOT EXISTS action_data jsonb DEFAULT '{}';

COMMENT ON COLUMN itachi_reminders.action_type IS 'Type of action: message (send text), close_done, close_failed, sync_repos, recall, custom';
COMMENT ON COLUMN itachi_reminders.action_data IS 'Extra params for the action (e.g. query for recall, command for custom)';

NOTIFY pgrst, 'reload schema';
