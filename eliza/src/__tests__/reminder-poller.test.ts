import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';

// ============================================================
// Reminder poller / action executor tests
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

// Mock Supabase (needed for ReminderService import chain)
let mockSupabaseResponse: Record<string, unknown> = { data: null, error: null };

const mockQueryBuilder: Record<string, Function> = {
  select: function () { return mockQueryBuilder; },
  insert: function () { return mockQueryBuilder; },
  update: function () { return mockQueryBuilder; },
  delete: function () { return mockQueryBuilder; },
  eq: function () { return mockQueryBuilder; },
  is: function () { return mockQueryBuilder; },
  lte: function () { return mockQueryBuilder; },
  like: function () { return mockQueryBuilder; },
  order: function () { return mockQueryBuilder; },
  limit: function () { return mockQueryBuilder; },
  single: function () { return Promise.resolve(mockSupabaseResponse); },
};

Object.defineProperty(mockQueryBuilder, 'then', {
  value: function (resolve: Function) {
    return Promise.resolve(mockSupabaseResponse).then(resolve);
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

// Stub github-sync to avoid real imports
mock.module('../plugins/itachi-tasks/services/github-sync', () => ({
  syncGitHubRepos: async () => ({ synced: 3, total: 5, errors: [] }),
}));

import { reminderPollerWorker } from '../plugins/itachi-tasks/workers/reminder-poller';
import type { ScheduledItem } from '../plugins/itachi-tasks/services/reminder-service';

// ============================================================
// Helpers
// ============================================================

function makeItem(overrides: Partial<ScheduledItem> = {}): ScheduledItem {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    telegram_chat_id: 12345,
    telegram_user_id: 67890,
    message: 'test message',
    remind_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago (due)
    recurring: null,
    action_type: 'message',
    action_data: {},
    sent_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createRuntime(opts: {
  dueItems?: ScheduledItem[];
  taskList?: any[];
  memories?: any[];
  actions?: any[];
} = {}) {
  const { dueItems = [], taskList = [], memories = [], actions = [] } = opts;

  const reminderService = {
    getDueReminders: async () => dueItems,
    markSent: async () => {},
  };

  const taskService = {
    listTasks: async () => taskList,
  };

  const topicsService = {
    closeTopic: async () => true,
  };

  const memoryService = {
    searchMemories: async () => memories,
  };

  const services: Record<string, any> = {
    'itachi-reminders': reminderService,
    'itachi-tasks': taskService,
    'telegram-topics': topicsService,
    'itachi-memory': memoryService,
  };

  return {
    getSetting: (key: string) => {
      const settings: Record<string, string> = {
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        TELEGRAM_BOT_TOKEN: 'test-bot-token',
      };
      return settings[key] || '';
    },
    getService: <T>(name: string): T | null => (services[name] as T) ?? null,
    actions,
    messageService: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as any;
}

// ============================================================
// Tests
// ============================================================

describe('reminderPollerWorker', () => {
  beforeEach(() => {
    telegramCalls = [];
    mockSupabaseResponse = { data: null, error: null };
  });

  describe('validate', () => {
    it('returns true when TELEGRAM_BOT_TOKEN and SUPABASE_URL are set', async () => {
      const runtime = createRuntime();
      const valid = await reminderPollerWorker.validate(runtime, {} as any);
      expect(valid).toBe(true);
    });

    it('returns false when TELEGRAM_BOT_TOKEN is missing', async () => {
      const runtime = createRuntime();
      runtime.getSetting = (key: string) => (key === 'TELEGRAM_BOT_TOKEN' ? '' : 'val');
      const valid = await reminderPollerWorker.validate(runtime, {} as any);
      expect(valid).toBe(false);
    });
  });

  describe('executeMessageAction', () => {
    it('sends a Telegram reminder message', async () => {
      const item = makeItem({ message: 'go to gym' });
      const runtime = createRuntime({ dueItems: [item] });

      await reminderPollerWorker.execute(runtime, {} as any);

      expect(telegramCalls.length).toBeGreaterThanOrEqual(1);
      const reminderCall = telegramCalls.find(c => c.body.text?.includes('Reminder'));
      expect(reminderCall).toBeTruthy();
      expect(reminderCall!.body.text).toContain('go to gym');
      expect(reminderCall!.body.chat_id).toBe(12345);
    });
  });

  describe('executeCloseTopics', () => {
    it('closes completed task topics', async () => {
      const item = makeItem({ action_type: 'close_done', message: 'close-done' });
      const tasks = [
        { id: 'task-1', project: 'test', telegram_topic_id: 100 },
        { id: 'task-2', project: 'test', telegram_topic_id: 200 },
      ];
      const runtime = createRuntime({ dueItems: [item], taskList: tasks });

      await reminderPollerWorker.execute(runtime, {} as any);

      const closeMsg = telegramCalls.find(c => c.body.text?.includes('Scheduled close'));
      expect(closeMsg).toBeTruthy();
      expect(closeMsg!.body.text).toContain('2/2');
    });

    it('sends "no topics" when none found', async () => {
      const item = makeItem({ action_type: 'close_done', message: 'close-done' });
      const runtime = createRuntime({ dueItems: [item], taskList: [] });

      await reminderPollerWorker.execute(runtime, {} as any);

      const msg = telegramCalls.find(c => c.body.text?.includes('No completed tasks'));
      expect(msg).toBeTruthy();
    });
  });

  describe('executeSyncRepos', () => {
    it('calls syncGitHubRepos and sends result', async () => {
      const item = makeItem({ action_type: 'sync_repos', message: 'sync-repos' });
      const runtime = createRuntime({ dueItems: [item] });

      await reminderPollerWorker.execute(runtime, {} as any);

      const msg = telegramCalls.find(c => c.body.text?.includes('Scheduled sync'));
      expect(msg).toBeTruthy();
      expect(msg!.body.text).toContain('3/5');
    });
  });

  describe('executeRecall', () => {
    it('sends memory search results', async () => {
      const item = makeItem({
        action_type: 'recall',
        message: 'recall: auth middleware',
        action_data: { query: 'auth middleware' },
      });
      const memories = [
        { category: 'fact', project: 'test', summary: 'Auth middleware uses JWT', similarity: 0.92 },
        { category: 'code', project: 'test', summary: 'Express middleware chain', similarity: 0.85 },
      ];
      const runtime = createRuntime({ dueItems: [item], memories });

      await reminderPollerWorker.execute(runtime, {} as any);

      const msg = telegramCalls.find(c => c.body.text?.includes('Scheduled recall'));
      expect(msg).toBeTruthy();
      expect(msg!.body.text).toContain('auth middleware');
      expect(msg!.body.text).toContain('0.92');
    });

    it('sends "no memories found" when empty', async () => {
      const item = makeItem({
        action_type: 'recall',
        message: 'recall: nonexistent',
        action_data: { query: 'nonexistent' },
      });
      const runtime = createRuntime({ dueItems: [item], memories: [] });

      await reminderPollerWorker.execute(runtime, {} as any);

      const msg = telegramCalls.find(c => c.body.text?.includes('no memories found'));
      expect(msg).toBeTruthy();
    });
  });

  describe('executeCustom', () => {
    it('dispatches to a registered action via tryDirectActionDispatch', async () => {
      const item = makeItem({
        action_type: 'custom',
        message: '/repos',
        action_data: { command: '/repos' },
      });

      const fakeAction = {
        name: 'LIST_REPOS',
        validate: async (_rt: any, msg: any) => msg.content?.text === '/repos',
        handler: async (_rt: any, _msg: any, _s: any, _o: any, cb: any) => {
          if (cb) await cb({ text: 'repo1, repo2, repo3' });
        },
      };

      const runtime = createRuntime({ dueItems: [item], actions: [fakeAction] });

      await reminderPollerWorker.execute(runtime, {} as any);

      // Should get a "Running scheduled action" notice + a "Done" message with results
      const startMsg = telegramCalls.find(c => c.body.text?.includes('Running scheduled action'));
      expect(startMsg).toBeTruthy();

      const doneMsg = telegramCalls.find(c => c.body.text?.includes('Done'));
      expect(doneMsg).toBeTruthy();
      expect(doneMsg!.body.text).toContain('repo1, repo2, repo3');
    });

    it('sends "could not execute" when no action matches', async () => {
      const item = makeItem({
        action_type: 'custom',
        message: 'do something weird',
        action_data: { command: 'do something weird' },
      });

      // No matching actions, no messageService
      const runtime = createRuntime({ dueItems: [item], actions: [] });

      await reminderPollerWorker.execute(runtime, {} as any);

      const msg = telegramCalls.find(c => c.body.text?.includes('Could not execute'));
      expect(msg).toBeTruthy();
    });
  });

  describe('error handling', () => {
    it('sends error alert to Telegram without crashing poller', async () => {
      const item = makeItem({ action_type: 'close_done', message: 'close-done' });
      const runtime = createRuntime({ dueItems: [item] });

      // Make taskService.listTasks throw
      (runtime.getService('itachi-tasks') as any).listTasks = async () => {
        throw new Error('DB connection lost');
      };

      // Should not throw
      await reminderPollerWorker.execute(runtime, {} as any);

      // Should have sent an error alert
      const errorMsg = telegramCalls.find(c => c.body.text?.includes('failed'));
      expect(errorMsg).toBeTruthy();
    });

    it('does not crash when reminderService is unavailable', async () => {
      const runtime = createRuntime();
      // Remove the reminder service
      (runtime as any).getService = () => null;

      // Should simply return without error
      await reminderPollerWorker.execute(runtime, {} as any);
      expect(telegramCalls).toHaveLength(0);
    });
  });
});
