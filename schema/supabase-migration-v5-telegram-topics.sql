-- Itachi Memory System - V5 Telegram Forum Topics
-- Adds telegram_topic_id to itachi_tasks for forum topic tracking
-- Also adds telegram_topic_id to the updateTask allowed fields
--
-- Run AFTER supabase-migration-v4-code-intel.sql

-- ============================================================
-- 1. Add telegram_topic_id column to itachi_tasks
-- ============================================================
ALTER TABLE itachi_tasks
  ADD COLUMN IF NOT EXISTS telegram_topic_id bigint;

-- Index for looking up tasks by topic
CREATE INDEX IF NOT EXISTS idx_itachi_tasks_topic_id
  ON itachi_tasks (telegram_topic_id)
  WHERE telegram_topic_id IS NOT NULL;

-- ============================================================
-- 2. Update claim_next_task to return the new column
-- ============================================================
-- The existing claim_next_task RPC already does SELECT * so it
-- automatically picks up new columns. No changes needed there.

-- ============================================================
-- 3. Comment for documentation
-- ============================================================
COMMENT ON COLUMN itachi_tasks.telegram_topic_id IS
  'Telegram forum topic message_thread_id for streaming task output';
