-- Persistent topic registry for Telegram forum topics.
-- Prevents topic ID orphaning when container restarts clear in-memory state.
-- Topic IDs are only marked 'deleted' AFTER confirmed Telegram API deletion.

CREATE TABLE IF NOT EXISTS itachi_topic_registry (
  id SERIAL PRIMARY KEY,
  topic_id INTEGER NOT NULL UNIQUE,
  chat_id BIGINT NOT NULL,
  title TEXT,
  task_id UUID REFERENCES itachi_tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'closed', 'deleted'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topic_registry_status ON itachi_topic_registry(status);
CREATE INDEX IF NOT EXISTS idx_topic_registry_chat_id ON itachi_topic_registry(chat_id);
