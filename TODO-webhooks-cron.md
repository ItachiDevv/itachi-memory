# Webhook API Server + Cron Scheduler

## Context

The bot currently has no way to receive external events (GitHub pushes, CI failures, Coolify deployments) — users must manually poll via `/gh` commands. The scheduler only supports simple `daily/weekly/weekdays` recurrence, not full cron expressions. Adding webhook ingestion and cron support makes the bot proactive instead of reactive.

All work happens in the worktree at `../itachi-memory-webhooks-cron` on the `webhooks-cron` branch.

**Re-evaluated Feb 21:** Recent commits added callback-handler.ts (Telegram inline button flows), conversation-flows.ts (multi-step task/session creation state machine), plugin-codex (Codex CLI text generation), worker throttle guards, and Docker restructuring. None of these conflict with or duplicate the webhook/cron work. The reminder infrastructure (`reminder-service.ts`, `reminder-commands.ts`, `reminder-poller.ts`) is unchanged and ready to extend.

---

## Phase 1: Database Migrations

### New table: `itachi_webhook_events`
```sql
CREATE TABLE itachi_webhook_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('github','coolify','generic')),
  event_type text NOT NULL,
  delivery_id text,
  repo text,
  payload jsonb NOT NULL DEFAULT '{}',
  summary text,
  telegram_message_id bigint,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX idx_webhook_dedup ON itachi_webhook_events(source, delivery_id) WHERE delivery_id IS NOT NULL;
```

### Extend `itachi_reminders` for cron
```sql
ALTER TABLE itachi_reminders ADD COLUMN IF NOT EXISTS cron_expression text;
ALTER TABLE itachi_reminders ADD COLUMN IF NOT EXISTS label text;
```

**Files:**
- `supabase/migrations/20260219000001_webhooks.sql`
- `supabase/migrations/20260219000002_cron_scheduler.sql`

---

## Phase 2: Cron Utilities

### New file: `eliza/src/plugins/itachi-tasks/utils/cron.ts`

Copy `parseCron()` and `getNextRun()` (~65 lines) from `eliza/src/plugins/itachi-agents/services/agent-cron-service.ts:157-221`. These are pure functions with zero dependencies — copying avoids cross-plugin coupling.

Exports: `parseCron(expr: string): CronFields | null`, `getNextRun(fields: CronFields, after: Date): Date`

---

## Phase 3: Extend ReminderService for Cron

### Modify: `eliza/src/plugins/itachi-tasks/services/reminder-service.ts`

1. Add `import { parseCron, getNextRun } from '../utils/cron.js'`
2. Extend `ScheduledItem` interface: add `cron_expression?: string | null`, `label?: string | null`
3. Extend `recurring` type: `'daily' | 'weekly' | 'weekdays' | 'cron' | null`
4. Update `createReminder()` opts: accept `cron_expression?: string`, `label?: string`; insert them into the row; set `recurring: 'cron'` when cron_expression is provided
5. Update `computeNext()`: add `case 'cron':` that calls `parseCron(cronExpression)` → `getNextRun(fields, current)`
6. Update `markSent()`: pass `cron_expression` and `label` when creating the next occurrence

---

## Phase 4: `/cron` Command

### Modify: `eliza/src/plugins/itachi-tasks/actions/reminder-commands.ts`

Add `/cron` to `validate()` and route in handler:

- `/cron <5-field-expr> <action>` — create cron job. Parse first 5 space-separated tokens as cron, rest is the action. Map known action names (`sync-repos` → `sync_repos`, `recall <query>` → `recall`, etc.). Default to `custom` action type.
- `/cron list` — list cron jobs (filter `itachi_reminders` where `recurring = 'cron'`)
- `/cron cancel <id>` — delegate to existing `cancelReminder()`

---

## Phase 5: Webhook Service

### New file: `eliza/src/plugins/itachi-tasks/services/webhook-service.ts`

```
WebhookService extends Service
├── serviceType = 'itachi-webhooks'
├── constructor(runtime) → init Supabase client
├── storeEvent({source, event_type, delivery_id, repo, payload, summary}) → insert, return event
├── isDuplicate(source, deliveryId) → try insert with ON CONFLICT, catch unique violation
├── getRecentEvents(source?, limit?) → query itachi_webhook_events ORDER BY created_at DESC
├── processGitHubEvent(eventType, payload) → format summary string per event type
├── processCoolifyEvent(payload) → format deployment status summary
└── sendToTelegram(runtime, text, topicId?) → runtime.sendMessageToTarget() or direct API
```

**GitHub event formatters:**
- `push` → "[repo] user pushed N commits to branch"
- `pull_request` → "[repo] PR #N opened/merged/closed: title"
- `issues` → "[repo] Issue #N opened/closed: title"
- `check_run` / `check_suite` → "[repo] CI check: conclusion"
- `deployment_status` → "[repo] Deploy to env: status"
- `release` → "[repo] Release tag published"
- default → "[source] event_type received"

**Telegram routing:** Use `WEBHOOK_TELEGRAM_TOPIC_ID` setting for a dedicated forum topic, fallback to `TELEGRAM_GROUP_CHAT_ID`.

---

## Phase 6: Webhook Routes

### New file: `eliza/src/plugins/itachi-tasks/routes/webhook-routes.ts`

Reuse `checkAuth()` pattern from `routes/task-stream.ts:38-53`.

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/webhooks/github` | HMAC-SHA256 (`GITHUB_WEBHOOK_SECRET`) | Verify signature, dedup by `X-GitHub-Delivery`, process, notify |
| POST | `/api/webhooks/coolify` | Bearer (`ITACHI_API_KEY`) | Dedup, process deploy event, notify |
| POST | `/api/webhooks/generic` | Bearer (`ITACHI_API_KEY`) | Store + notify with event_type from `X-Event-Type` header |
| GET | `/api/webhooks/events` | Bearer (`ITACHI_API_KEY`) | Query recent events with optional `?source=&limit=` filters |

**HMAC-SHA256 verification:**
```typescript
import { createHmac, timingSafeEqual } from 'crypto';
function verifyGitHubSignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Raw body access: check `(req as any).rawBody` first (Express pattern), fallback to `JSON.stringify(req.body)`.

---

## Phase 7: `/webhooks` Command

### New file: `eliza/src/plugins/itachi-tasks/actions/webhook-commands.ts`

```
webhookCommandsAction: Action
├── validate: /^\/webhooks?\b/
├── handler routes:
│   ├── /webhooks setup — show webhook URLs + config instructions
│   ├── /webhooks events [N] — list last N events from DB
│   └── /webhooks test — send synthetic test event through pipeline
```

---

## Phase 8: Plugin Registration

### Modify: `eliza/src/plugins/itachi-tasks/index.ts`

1. Import `WebhookService`, `webhookRoutes`, `webhookCommandsAction`
2. Add `WebhookService` to `services` array
3. Add `webhookCommandsAction` to `actions` array
4. Register `webhookRoutes` in `init()` alongside existing routes
5. Add to Telegram command menu:
   ```typescript
   { command: 'webhooks', description: 'Manage webhooks — /webhooks setup|events' },
   { command: 'cron', description: 'Cron jobs — /cron <expr> <action> | list | cancel' },
   ```
6. Add `/webhooks` and `/cron` to `command-suppressor.ts` KNOWN_COMMANDS set

---

## New Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for GitHub signature validation | For GitHub webhooks |
| `WEBHOOK_TELEGRAM_TOPIC_ID` | Forum topic for webhook notifications | Optional |

Existing vars already handle the rest: `ITACHI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

---

## Files Summary

### New files (6)
- `supabase/migrations/20260219000001_webhooks.sql`
- `supabase/migrations/20260219000002_cron_scheduler.sql`
- `eliza/src/plugins/itachi-tasks/utils/cron.ts`
- `eliza/src/plugins/itachi-tasks/services/webhook-service.ts`
- `eliza/src/plugins/itachi-tasks/routes/webhook-routes.ts`
- `eliza/src/plugins/itachi-tasks/actions/webhook-commands.ts`

### Modified files (4)
- `eliza/src/plugins/itachi-tasks/services/reminder-service.ts` — cron support
- `eliza/src/plugins/itachi-tasks/actions/reminder-commands.ts` — `/cron` command
- `eliza/src/plugins/itachi-tasks/index.ts` — register new service, routes, action, commands
- `eliza/src/plugins/itachi-tasks/providers/command-suppressor.ts` — add `/webhooks`, `/cron`

---

## Verification

1. **Build**: `cd eliza && bun run build` — no TS errors
2. **Migrations**: Run both SQL files against Supabase, verify tables
3. **Cron test**: `/cron */5 * * * * sync-repos` → verify reminder row with `recurring='cron'`, correct `remind_at`
4. **Cron list/cancel**: `/cron list` shows job, `/cron cancel <id>` removes it
5. **GitHub webhook**: `curl -X POST https://<bot-url>/api/webhooks/github -H "X-Hub-Signature-256: sha256=..." -H "X-GitHub-Event: push" -H "X-GitHub-Delivery: test-123" -d '{...}'` → 200, event stored, Telegram notification received
6. **Dedup**: Repeat same curl → returns success but no new row/message
7. **Invalid signature**: Wrong HMAC → 401 rejected
8. **Coolify webhook**: POST to `/api/webhooks/coolify` with Bearer token → notification
9. **`/webhooks events`**: Shows recent events in Telegram
10. **Deploy**: Push branch, deploy to Coolify, verify in production
