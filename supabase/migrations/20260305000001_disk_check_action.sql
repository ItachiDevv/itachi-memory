-- Add disk_check to the action_type constraint on itachi_reminders
ALTER TABLE itachi_reminders DROP CONSTRAINT IF EXISTS itachi_reminders_action_type_check;

ALTER TABLE itachi_reminders
  ADD CONSTRAINT itachi_reminders_action_type_check
  CHECK (action_type IN ('message', 'close_done', 'close_failed', 'sync_repos', 'recall', 'custom', 'disk_check'));

COMMENT ON COLUMN itachi_reminders.action_type IS 'Type of action: message, close_done, close_failed, sync_repos, recall, custom, disk_check';

NOTIFY pgrst, 'reload schema';
