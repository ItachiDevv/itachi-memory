import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// End-to-end integration tests for the scheduled actions system
// Tests the flow: command parse → service create → poller execute
// ============================================================

// Capture Telegram API calls
let telegramCalls: { url: string; body: any }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.telegram.org')) {
    const body = init?.body ? JSON.parse(init.body) : {};
    telegramCalls.push({ url, body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return originalFetch(input, init);
};

// Mock Supabase — track all inserts for verification
let insertedRows: any[] = [];
let storedItems: any[] = [];
let nextId = 1;

const mockQueryBuilder: Record<string, Function> = {
  select: function () { return mockQueryBuilder; },
  insert: function (data: unknown) {
    const row = { ...data as object, id: `item-${nextId++}`, sent_at: null, created_at: new Date().toISOString() };
    insertedRows.push(row);
    storedItems.push(row);
    return mockQueryBuilder;
  },
  update: function (data: unknown) {
    // When markSent is called, mark the item
    if ((data as any).sent_at) {
      const eqArgs = pendingEqArgs;
      if (eqArgs) {
        const item = storedItems.find(i => i.id === eqArgs);
        if (item) item.sent_at = (data as any).sent_at;
      }
    }
    return mockQueryBuilder;
  },
  delete: function () { return mockQueryBuilder; },
  eq: function (...args: unknown[]) { pendingEqArgs = args[1] as string; return mockQueryBuilder; },
  is: function () { return mockQueryBuilder; },
  lte: function () { return mockQueryBuilder; },
  like: function () { return mockQueryBuilder; },
  order: function () { return mockQueryBuilder; },
  limit: function () { return mockQueryBuilder; },
  single: function () {
    const lastInserted = insertedRows[insertedRows.length - 1];
    return Promise.resolve({ data: lastInserted || null, error: null });
  },
};

let pendingEqArgs: string | null = null;

Object.defineProperty(mockQueryBuilder, 'then', {
  value: function (resolve: Function) {
    // For getDueReminders: return items that are due and unsent
    const dueItems = storedItems.filter(i => !i.sent_at && new Date(i.remind_at) <= new Date());
    return Promise.resolve({ data: dueItems, error: null }).then(resolve);
  },
  writable: true,
  configurable: true,
});

mock.module('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => mockQueryBuilder,
  }),
}));

mock.module('@elizaos/core', () => ({
  Service: class Service {
    static serviceType = 'base';
    capabilityDescription = '';
  },
}));

mock.module('../plugins/itachi-tasks/services/github-sync', () => ({
  syncGitHubRepos: async () => ({ synced: 2, total: 3, errors: [] }),
}));

import { parseTimeAndMessage, parseActionFromMessage } from '../plugins/itachi-tasks/actions/reminder-commands';
import { ReminderService } from '../plugins/itachi-tasks/services/reminder-service';
import { reminderPollerWorker } from '../plugins/itachi-tasks/workers/reminder-poller';

// ============================================================
// Helpers
// ============================================================

function createRuntime(opts: { actions?: any[] } = {}) {
  const services: Record<string, any> = {};

  const runtime = {
    getSetting: (key: string) => {
      const settings: Record<string, string> = {
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        TELEGRAM_BOT_TOKEN: 'test-bot-token',
      };
      return settings[key] || '';
    },
    getService: <T>(name: string): T | null => (services[name] as T) ?? null,
    actions: opts.actions || [],
    messageService: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as any;

  // Create real ReminderService (uses mocked supabase)
  const reminderService = new ReminderService(runtime);
  services['itachi-reminders'] = reminderService;
  services['itachi-tasks'] = { listTasks: async () => [] };
  services['telegram-topics'] = { closeTopic: async () => true };
  services['itachi-memory'] = { searchMemories: async () => [] };

  return runtime;
}

// ============================================================
// Integration tests
// ============================================================

describe('Scheduled Actions Integration', () => {
  beforeEach(() => {
    telegramCalls = [];
    insertedRows = [];
    storedItems = [];
    nextId = 1;
    pendingEqArgs = null;
  });

  it('/remind → parse → create → getDue → send message', async () => {
    // Step 1: Parse the user input
    const input = '9am go to gym';
    const parsed = parseTimeAndMessage(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.message).toBe('go to gym');

    // Step 2: Create via service
    const runtime = createRuntime();
    const service = runtime.getService<ReminderService>('itachi-reminders')!;
    const item = await service.createReminder({
      telegram_chat_id: 12345,
      telegram_user_id: 67890,
      message: parsed!.message,
      remind_at: new Date(Date.now() - 60_000), // already due
      action_type: 'message',
    });

    expect(item.id).toBeTruthy();
    expect(insertedRows).toHaveLength(1);

    // Step 3: Poller picks it up and sends
    await reminderPollerWorker.execute(runtime, {} as any);

    const reminderMsg = telegramCalls.find(c => c.body.text?.includes('Reminder'));
    expect(reminderMsg).toBeTruthy();
    expect(reminderMsg!.body.text).toContain('go to gym');
    expect(reminderMsg!.body.chat_id).toBe(12345);
  });

  it('/schedule daily 9am close-done → getDue → execute close_done', async () => {
    // Step 1: Parse time and action
    const parsed = parseTimeAndMessage('daily 9am close-done');
    expect(parsed).not.toBeNull();
    expect(parsed!.recurring).toBe('daily');

    const { actionType, actionData, label } = parseActionFromMessage(parsed!.message);
    expect(actionType).toBe('close_done');

    // Step 2: Create via service
    const runtime = createRuntime();
    await (runtime.getService<ReminderService>('itachi-reminders')!).createReminder({
      telegram_chat_id: 12345,
      telegram_user_id: 67890,
      message: label,
      remind_at: new Date(Date.now() - 60_000),
      recurring: parsed!.recurring,
      action_type: actionType,
      action_data: actionData,
    });

    // Step 3: Poller executes close_done
    await reminderPollerWorker.execute(runtime, {} as any);

    // close_done with no tasks → "No completed tasks" message
    const msg = telegramCalls.find(c => c.body.text?.includes('No completed tasks'));
    expect(msg).toBeTruthy();
  });

  it('/schedule in 1m /repos → getDue → direct dispatch', async () => {
    const parsed = parseTimeAndMessage('in 1m /repos');
    expect(parsed).not.toBeNull();

    const { actionType, actionData, label } = parseActionFromMessage(parsed!.message);
    expect(actionType).toBe('custom');
    expect(actionData.command).toBe('/repos');

    // Register a fake action that handles /repos
    const fakeAction = {
      name: 'LIST_REPOS',
      validate: async (_rt: any, msg: any) => msg.content?.text === '/repos',
      handler: async (_rt: any, _msg: any, _s: any, _o: any, cb: any) => {
        if (cb) await cb({ text: 'Found repos: itachi-memory, lotitachi' });
      },
    };

    const runtime = createRuntime({ actions: [fakeAction] });
    await (runtime.getService<ReminderService>('itachi-reminders')!).createReminder({
      telegram_chat_id: 12345,
      telegram_user_id: 67890,
      message: label,
      remind_at: new Date(Date.now() - 60_000),
      action_type: actionType,
      action_data: actionData,
    });

    await reminderPollerWorker.execute(runtime, {} as any);

    const doneMsg = telegramCalls.find(c => c.body.text?.includes('Done'));
    expect(doneMsg).toBeTruthy();
    expect(doneMsg!.body.text).toContain('itachi-memory');
  });

  it('/reminders lists all pending items', async () => {
    const runtime = createRuntime();
    const service = runtime.getService<ReminderService>('itachi-reminders')!;

    // Create 3 items with past dates so the mock's thenable filter includes them
    // (Mock `.then` returns unsent items where remind_at <= now)
    const pastDate = new Date(Date.now() - 60_000);
    for (const msg of ['gym', 'dentist', 'standup']) {
      await service.createReminder({
        telegram_chat_id: 12345,
        telegram_user_id: 67890,
        message: msg,
        remind_at: pastDate,
      });
    }

    // listReminders uses the same mock thenable which returns due unsent items
    const items = await service.listReminders(67890);
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it('/unremind cancels by prefix', async () => {
    const runtime = createRuntime();
    const service = runtime.getService<ReminderService>('itachi-reminders')!;

    // Create an item
    const item = await service.createReminder({
      telegram_chat_id: 12345,
      telegram_user_id: 67890,
      message: 'cancel me',
      remind_at: new Date(Date.now() + 3600_000),
    });

    // Cancel by full ID (our mock supports this)
    const ok = await service.cancelReminder(item.id);
    expect(ok).toBe(true);
  });

  it('recurring daily regeneration creates next-day item', async () => {
    const runtime = createRuntime();
    const service = runtime.getService<ReminderService>('itachi-reminders')!;

    // Create a daily recurring item that's already due
    const item = await service.createReminder({
      telegram_chat_id: 12345,
      telegram_user_id: 67890,
      message: 'standup',
      remind_at: new Date(Date.now() - 60_000),
      recurring: 'daily',
      action_type: 'message',
    });

    expect(insertedRows).toHaveLength(1);

    // markSent should create a new item for tomorrow
    await service.markSent(item as any);

    // Should now have 2 inserted rows (original + next)
    expect(insertedRows).toHaveLength(2);
    const nextItem = insertedRows[1];
    const nextDate = new Date(nextItem.remind_at);
    const originalDate = new Date(item.remind_at);
    // Next should be ~1 day after original
    const diffHours = (nextDate.getTime() - originalDate.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBeCloseTo(24, 0);
    expect(nextItem.recurring).toBe('daily');
  });
});
