-- Daily 9am UTC coolify disk usage check
-- Removes any existing unsent reminder with this description, then inserts fresh one.

DELETE FROM itachi_reminders
WHERE sent_at IS NULL
  AND message = 'on coolify, run df -h and report disk usage'
  AND recurring = 'daily';

INSERT INTO itachi_reminders (
    telegram_chat_id,
    telegram_user_id,
    message,
    remind_at,
    recurring,
    action_type,
    action_data
) VALUES (
    -1003521359823,
    6511700918,
    'on coolify, run df -h and report disk usage',
    '2026-03-06 09:00:00+00',
    'daily',
    'custom',
    '{"command": "on coolify, run df -h and report disk usage"}'
);

NOTIFY pgrst, 'reload schema';
