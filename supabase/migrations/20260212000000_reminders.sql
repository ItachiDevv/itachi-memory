-- Itachi Reminders — scheduled messages via Telegram
CREATE TABLE IF NOT EXISTS itachi_reminders (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    telegram_chat_id bigint NOT NULL,
    telegram_user_id bigint NOT NULL,
    message text NOT NULL,
    remind_at timestamptz NOT NULL,
    recurring text DEFAULT NULL CHECK (recurring IN ('daily', 'weekly', 'weekdays', NULL)),
    sent_at timestamptz DEFAULT NULL,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_itachi_reminders_due
    ON itachi_reminders (remind_at)
    WHERE sent_at IS NULL;

NOTIFY pgrst, 'reload schema';
