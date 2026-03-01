import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// ============================================================
// Mock external dependencies
// ============================================================

mock.module('@elizaos/core', () => ({
  Service: class {
    static serviceType = 'base';
    capabilityDescription = '';
    constructor(runtime?: any) { (this as any).runtime = runtime; }
  },
}));

// Mock task-service to provide generateTaskTitle and ItachiTask type
mock.module('../plugins/itachi-tasks/services/task-service.js', () => ({
  TaskService: class {},
  generateTaskTitle: (desc: string) => {
    // Simple mock: first 3 words hyphenated
    return desc.split(/\s+/).slice(0, 3).join('-').toLowerCase().substring(0, 40);
  },
}));

// ============================================================
// Import after mocks
// ============================================================

import { TelegramTopicsService } from '../plugins/itachi-tasks/services/telegram-topics.js';
import type { ParsedChunk } from '../plugins/itachi-tasks/shared/parsed-chunks.js';

// ============================================================
// Test helpers
// ============================================================

/** Captured fetch calls */
let fetchCalls: Array<{ url: string; body: any }> = [];
/** Queued fetch responses (shift from front) */
let fetchResponses: Array<any> = [];

const originalFetch = globalThis.fetch;

function installFetchMock() {
  (globalThis as any).fetch = async (url: string, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    fetchCalls.push({ url, body });
    const response = fetchResponses.shift() || { ok: true, result: {} };
    return {
      json: async () => response,
    };
  };
}

function restoreFetchMock() {
  globalThis.fetch = originalFetch;
}

function queueResponse(resp: any) {
  fetchResponses.push(resp);
}

function queueOk(result: any = {}) {
  fetchResponses.push({ ok: true, result });
}

function queueError(description: string) {
  fetchResponses.push({ ok: false, description });
}

function makeMockRuntime(opts: {
  botToken?: string;
  chatId?: string;
  services?: Record<string, any>;
} = {}) {
  const logs: { level: string; msg: string }[] = [];
  const runtime: any = {
    getService: (name: string) => opts.services?.[name] ?? null,
    getSetting: (key: string) => {
      if (key === 'TELEGRAM_BOT_TOKEN') return opts.botToken !== undefined ? opts.botToken : 'test-bot-token';
      if (key === 'TELEGRAM_GROUP_CHAT_ID') return opts.chatId !== undefined ? opts.chatId : '-1001234567890';
      return null;
    },
    logger: {
      info: (...args: any[]) => logs.push({ level: 'info', msg: args.map(String).join(' ') }),
      warn: (...args: any[]) => logs.push({ level: 'warn', msg: args.map(String).join(' ') }),
      error: (...args: any[]) => logs.push({ level: 'error', msg: args.map(String).join(' ') }),
    },
  };
  return { runtime, logs };
}

function makeMockSupabase(overrides: Record<string, any> = {}) {
  const queryBuilder: any = {
    select: () => queryBuilder,
    eq: () => queryBuilder,
    neq: () => queryBuilder,
    limit: () => queryBuilder,
    upsert: async () => ({ data: null, error: null }),
    update: () => queryBuilder,
    then: (cb: Function) => Promise.resolve({ data: [], error: null }).then(cb),
    ...overrides,
  };
  return {
    from: () => queryBuilder,
  };
}

function makeMockTaskService(supabaseOverrides: Record<string, any> = {}, taskOverrides: Record<string, any> = {}) {
  const supabase = makeMockSupabase(supabaseOverrides);
  return {
    getSupabase: () => supabase,
    updateTask: async () => {},
    ...taskOverrides,
  };
}

function makeTask(overrides: Record<string, any> = {}): any {
  return {
    id: 'task-abc-12345678',
    description: 'Fix the broken auth flow',
    project: 'itachi-memory',
    branch: 'fix-auth',
    status: 'queued',
    priority: 5,
    model: 'claude',
    max_budget_usd: 1,
    files_changed: [],
    telegram_chat_id: -100123,
    telegram_user_id: 42,
    created_at: '2026-01-01',
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('TelegramTopicsService', () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchResponses = [];
    installFetchMock();
  });

  afterEach(() => {
    restoreFetchMock();
  });

  // ── HTML escaping ─────────────────────────────────────────

  describe('HTML escaping (via formatChunkHtml)', () => {
    it('should escape &, <, > in text chunks', async () => {
      const taskService = makeMockTaskService();
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      // Send a text chunk that will be formatted via formatChunkHtml
      queueOk({ message_id: 1 }); // for sendHtmlToTopic via flushBuffer

      await service.receiveTypedChunk('t1', 100, { kind: 'text', text: '<script>alert("xss")&</script>' });
      // Force flush
      await service.finalFlush('t1');

      // The flushed HTML should have escaped entities
      const sendCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      expect(sendCall).toBeDefined();
      expect(sendCall!.body.text).toContain('&lt;script&gt;');
      expect(sendCall!.body.text).toContain('&amp;');
      expect(sendCall!.body.text).toContain('&lt;/script&gt;');
    });
  });

  // ── formatChunkHtml (tested via receiveTypedChunk + flush) ─

  describe('formatChunkHtml variants', () => {
    it('should format hook_response as italic', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 2 });

      await service.receiveTypedChunk('t2', 200, { kind: 'hook_response', text: 'Hook ran' });
      await service.finalFlush('t2');

      const sendCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      expect(sendCall!.body.text).toContain('<i>Hook ran</i>');
    });

    it('should format result as bold session status', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 3 }); // for sendHtmlToTopic

      await service.receiveTypedChunk('t3', 300, {
        kind: 'result', subtype: 'completed', cost: '$0.12', duration: '5m',
      });

      // result is sent immediately, not buffered
      const sendCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      expect(sendCall).toBeDefined();
      expect(sendCall!.body.text).toContain('<b>[Session completed]</b>');
      expect(sendCall!.body.text).toContain('Cost: $0.12');
      expect(sendCall!.body.text).toContain('Duration: 5m');
    });

    it('should format ask_user as bold question', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 4, result: { message_id: 4 } }); // sendMessageWithKeyboard

      await service.receiveTypedChunk('t4', 400, {
        kind: 'ask_user', toolId: 'tool1', question: 'Continue?', options: ['Yes', 'No'],
      });

      const sendCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      expect(sendCall!.body.text).toContain('<b>Question:</b>');
      expect(sendCall!.body.text).toContain('Continue?');
    });

    it('should format passthrough as plain escaped text', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 5 });

      await service.receiveTypedChunk('t5', 500, { kind: 'passthrough', text: 'raw <output>' });
      await service.finalFlush('t5');

      const sendCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      expect(sendCall!.body.text).toContain('raw &lt;output&gt;');
    });
  });

  // ── sendToTopic ───────────────────────────────────────────

  describe('sendToTopic', () => {
    it('should send a short message in a single API call', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 10 });

      const msgId = await service.sendToTopic(100, 'Hello topic');

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].body.text).toBe('Hello topic');
      expect(fetchCalls[0].body.message_thread_id).toBe(100);
      expect(msgId).toBe(10);
    });

    it('should split long messages into multiple chunks', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      // Create a message longer than 4000 chars
      const longLine = 'A'.repeat(2000);
      const longText = `${longLine}\n${longLine}\n${longLine}`;

      // Queue enough responses for all chunks (could be 2-3 depending on split)
      queueOk({ message_id: 11 });
      queueOk({ message_id: 12 });
      queueOk({ message_id: 13 });

      const msgId = await service.sendToTopic(200, longText);

      expect(fetchCalls.length).toBeGreaterThan(1);
      // msgId is the last successfully sent message
      expect(msgId).toBeGreaterThan(0);
    });

    it('should return null when not enabled (no token)', async () => {
      const { runtime } = makeMockRuntime({ botToken: '' });
      const service = new TelegramTopicsService(runtime);

      const result = await service.sendToTopic(100, 'test');
      expect(result).toBeNull();
      expect(fetchCalls.length).toBe(0);
    });

    it('should return null when topicId is 0', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      const result = await service.sendToTopic(0, 'test');
      expect(result).toBeNull();
    });

    it('should log error when API call fails', async () => {
      const { runtime, logs } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueError('Bad Request: message is too long');

      await service.sendToTopic(100, 'test');

      expect(logs.some(l => l.level === 'error' && l.msg.includes('sendToTopic failed'))).toBe(true);
    });
  });

  // ── closeTopic ────────────────────────────────────────────

  describe('closeTopic', () => {
    it('should call closeForumTopic API', async () => {
      const taskService = makeMockTaskService();
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      queueOk(); // closeForumTopic

      const result = await service.closeTopic(100);
      expect(result).toBe(true);

      const closeCall = fetchCalls.find(c => c.url.includes('closeForumTopic'));
      expect(closeCall).toBeDefined();
      expect(closeCall!.body.message_thread_id).toBe(100);
    });

    it('should also call editForumTopic when status is provided', async () => {
      const taskService = makeMockTaskService();
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      queueOk(); // closeForumTopic
      queueOk(); // editForumTopic

      await service.closeTopic(100, 'DONE | fix-auth | itachi-memory');

      const editCall = fetchCalls.find(c => c.url.includes('editForumTopic'));
      expect(editCall).toBeDefined();
      expect(editCall!.body.name).toBe('DONE | fix-auth | itachi-memory');
    });

    it('should NOT call editForumTopic when no status is provided', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk(); // closeForumTopic

      await service.closeTopic(100);

      const editCall = fetchCalls.find(c => c.url.includes('editForumTopic'));
      expect(editCall).toBeUndefined();
    });

    it('should update registry to closed on success', async () => {
      let updateCalled = false;
      const queryBuilder: any = {
        update: (data: any) => {
          if (data.status === 'closed') updateCalled = true;
          return queryBuilder;
        },
        eq: () => queryBuilder,
        then: (cb: Function) => Promise.resolve({ data: null, error: null }).then(cb),
      };
      const taskService = {
        getSupabase: () => ({ from: () => queryBuilder }),
      };
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      queueOk(); // closeForumTopic

      await service.closeTopic(100);
      expect(updateCalled).toBe(true);
    });

    it('should return false when not enabled', async () => {
      const { runtime } = makeMockRuntime({ botToken: '' });
      const service = new TelegramTopicsService(runtime);

      const result = await service.closeTopic(100);
      expect(result).toBe(false);
      expect(fetchCalls.length).toBe(0);
    });
  });

  // ── createTopicForTask ────────────────────────────────────

  describe('createTopicForTask', () => {
    it('should call createForumTopic and sendMessage APIs', async () => {
      const taskService = makeMockTaskService();
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_thread_id: 999 }); // createForumTopic
      queueOk({ message_id: 50 });          // sendMessage
      // registerTopic will use supabase mock (no fetch call)

      const result = await service.createTopicForTask(makeTask());

      expect(result).not.toBeNull();
      expect(result!.topicId).toBe(999);
      expect(result!.messageId).toBe(50);

      const createCall = fetchCalls.find(c => c.url.includes('createForumTopic'));
      expect(createCall).toBeDefined();
      expect(createCall!.body.name).toContain('itachi-memory');

      const msgCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      expect(msgCall).toBeDefined();
      expect(msgCall!.body.message_thread_id).toBe(999);
    });

    it('should store topic ID on the task', async () => {
      let updatedTaskId: string | null = null;
      let updatedFields: any = null;
      const taskService = makeMockTaskService({}, {
        updateTask: async (id: string, fields: any) => {
          updatedTaskId = id;
          updatedFields = fields;
        },
      });
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_thread_id: 888 }); // createForumTopic
      queueOk({ message_id: 51 });          // sendMessage

      const task = makeTask();
      await service.createTopicForTask(task);

      expect(updatedTaskId).toBe(task.id);
      expect(updatedFields.telegram_topic_id).toBe(888);
    });

    it('should prevent concurrent creation for the same task (dedup guard)', async () => {
      const taskService = makeMockTaskService();
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      // Queue responses for only one successful creation
      queueOk({ message_thread_id: 777 }); // createForumTopic
      queueOk({ message_id: 52 });          // sendMessage

      const task = makeTask();

      // Fire two concurrent calls
      const [result1, result2] = await Promise.all([
        service.createTopicForTask(task),
        service.createTopicForTask(task),
      ]);

      // One should succeed, one should return null (dedup)
      const results = [result1, result2];
      const successCount = results.filter(r => r !== null).length;
      const nullCount = results.filter(r => r === null).length;
      expect(successCount).toBe(1);
      expect(nullCount).toBe(1);
    });

    it('should return null on API failure', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueError('Bad Request: not enough rights');

      const result = await service.createTopicForTask(makeTask());
      expect(result).toBeNull();
    });

    it('should return null when not enabled', async () => {
      const { runtime } = makeMockRuntime({ botToken: '' });
      const service = new TelegramTopicsService(runtime);

      const result = await service.createTopicForTask(makeTask());
      expect(result).toBeNull();
      expect(fetchCalls.length).toBe(0);
    });
  });

  // ── forceDeleteTopic ──────────────────────────────────────

  describe('forceDeleteTopic', () => {
    it('should call reopen, close, then delete sequence', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk(); // reopenForumTopic
      queueOk(); // closeForumTopic
      queueOk(); // deleteForumTopic

      const result = await service.forceDeleteTopic(100);
      expect(result).toBe(true);

      const methods = fetchCalls.map(c => {
        const urlParts = c.url.split('/');
        return urlParts[urlParts.length - 1];
      });
      expect(methods).toContain('reopenForumTopic');
      expect(methods).toContain('closeForumTopic');
      expect(methods).toContain('deleteForumTopic');

      // Verify order: reopen before close before delete
      const reopenIdx = methods.indexOf('reopenForumTopic');
      const closeIdx = methods.indexOf('closeForumTopic');
      const deleteIdx = methods.indexOf('deleteForumTopic');
      expect(reopenIdx).toBeLessThan(closeIdx);
      expect(closeIdx).toBeLessThan(deleteIdx);
    });

    it('should return false when not enabled', async () => {
      const { runtime } = makeMockRuntime({ botToken: '' });
      const service = new TelegramTopicsService(runtime);

      const result = await service.forceDeleteTopic(100);
      expect(result).toBe(false);
    });

    it('should return false when topicId is 0', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      const result = await service.forceDeleteTopic(0);
      expect(result).toBe(false);
    });
  });

  // ── receiveTypedChunk ─────────────────────────────────────

  describe('receiveTypedChunk', () => {
    it('should flush buffer and send keyboard for ask_user chunk', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 60 }); // sendMessageWithKeyboard

      await service.receiveTypedChunk('t10', 600, {
        kind: 'ask_user', toolId: 'tool1', question: 'Proceed?', options: ['Yes', 'No'],
      });

      const sendCall = fetchCalls.find(c => c.url.includes('sendMessage'));
      expect(sendCall).toBeDefined();
      expect(sendCall!.body.reply_markup).toBeDefined();
      expect(sendCall!.body.reply_markup.inline_keyboard).toBeDefined();
    });

    it('should flush buffer and send HTML for result chunk', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      // First buffer some text
      queueOk({ message_id: 61 }); // flush of buffered text
      queueOk({ message_id: 62 }); // result message

      await service.receiveTypedChunk('t11', 700, { kind: 'text', text: 'Processing...' });
      await service.receiveTypedChunk('t11', 700, {
        kind: 'result', subtype: 'completed', cost: '$0.05',
      });

      // Result triggers immediate send
      const htmlCalls = fetchCalls.filter(c =>
        c.url.includes('sendMessage') && c.body.parse_mode === 'HTML',
      );
      expect(htmlCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should buffer text chunks and not send immediately', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      await service.receiveTypedChunk('t12', 800, { kind: 'text', text: 'Line 1' });

      // No fetch calls yet (text is buffered)
      expect(fetchCalls.length).toBe(0);

      // Clean up
      const buf = (service as any).buffers.get('t12');
      if (buf?.flushTimer) clearTimeout(buf.flushTimer);
      (service as any).buffers.delete('t12');
    });

    it('should flush on kind change', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 63 }); // flush of text
      queueOk({ message_id: 64 }); // flush of hook_response

      await service.receiveTypedChunk('t13', 900, { kind: 'text', text: 'Hello' });
      await service.receiveTypedChunk('t13', 900, { kind: 'hook_response', text: 'Hook output' });

      // Kind change should have triggered a flush
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);

      // Clean up
      await service.finalFlush('t13');
    });

    it('should do nothing when not enabled', async () => {
      const { runtime } = makeMockRuntime({ botToken: '' });
      const service = new TelegramTopicsService(runtime);

      await service.receiveTypedChunk('t14', 100, { kind: 'text', text: 'test' });
      expect(fetchCalls.length).toBe(0);
    });
  });

  // ── Registry operations ───────────────────────────────────

  describe('Registry operations', () => {
    it('registerTopic should upsert to registry', async () => {
      let upsertData: any = null;
      const queryBuilder: any = {
        upsert: async (data: any, opts: any) => {
          upsertData = data;
          return { data: null, error: null };
        },
      };
      const taskService = {
        getSupabase: () => ({ from: (table: string) => {
          if (table === 'itachi_topic_registry') return queryBuilder;
          return queryBuilder;
        }}),
      };
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      await service.registerTopic(123, 'Test Topic', 'task-xyz');

      expect(upsertData).not.toBeNull();
      expect(upsertData.topic_id).toBe(123);
      expect(upsertData.title).toBe('Test Topic');
      expect(upsertData.task_id).toBe('task-xyz');
      expect(upsertData.status).toBe('active');
    });

    it('getRegisteredTopicIds should return set of topic IDs', async () => {
      const queryBuilder: any = {
        select: () => queryBuilder,
        neq: () => queryBuilder,
        eq: () => queryBuilder,
        limit: () => Promise.resolve({
          data: [{ topic_id: 100 }, { topic_id: 200 }, { topic_id: 300 }],
          error: null,
        }),
      };
      const taskService = {
        getSupabase: () => ({ from: () => queryBuilder }),
      };
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      const ids = await service.getRegisteredTopicIds();

      expect(ids.size).toBe(3);
      expect(ids.has(100)).toBe(true);
      expect(ids.has(200)).toBe(true);
      expect(ids.has(300)).toBe(true);
    });

    it('getRegisteredTopicIds should return empty set when no task service', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      const ids = await service.getRegisteredTopicIds();
      expect(ids.size).toBe(0);
    });

    it('unregisterTopic should update status to deleted', async () => {
      let updateData: any = null;
      let eqTopicId: number | null = null;
      const queryBuilder: any = {
        update: (data: any) => {
          updateData = data;
          return queryBuilder;
        },
        eq: (field: string, value: any) => {
          if (field === 'topic_id') eqTopicId = value;
          return Promise.resolve({ data: null, error: null });
        },
      };
      const taskService = {
        getSupabase: () => ({ from: () => queryBuilder }),
      };
      const { runtime } = makeMockRuntime({ services: { 'itachi-tasks': taskService } });
      const service = new TelegramTopicsService(runtime);

      await service.unregisterTopic(456);

      expect(updateData).not.toBeNull();
      expect(updateData.status).toBe('deleted');
      expect(eqTopicId).toBe(456);
    });

    it('registerTopic should not crash when no task service', async () => {
      const { runtime } = makeMockRuntime(); // no services
      const service = new TelegramTopicsService(runtime);

      // Should not throw
      await service.registerTopic(123, 'Test', 'task-id');
    });
  });

  // ── splitMessage (tested via sendToTopic) ─────────────────

  describe('splitMessage behavior', () => {
    it('should not split short text', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      queueOk({ message_id: 70 });

      await service.sendToTopic(100, 'Short message');
      expect(fetchCalls.length).toBe(1);
    });

    it('should split at newlines when possible', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      // Build text with clear newline split points
      const line = 'X'.repeat(1500);
      const text = `${line}\n${line}\n${line}`;

      queueOk({ message_id: 71 });
      queueOk({ message_id: 72 });

      await service.sendToTopic(100, text);

      // Should have split into multiple messages
      expect(fetchCalls.length).toBeGreaterThan(1);
      // Each chunk should be <= 4000 chars
      for (const call of fetchCalls) {
        expect(call.body.text.length).toBeLessThanOrEqual(4000);
      }
    });

    it('should split at maxLen when no newline found in reasonable range', async () => {
      const { runtime } = makeMockRuntime();
      const service = new TelegramTopicsService(runtime);

      // Single very long line with no newlines
      const text = 'Y'.repeat(8000);

      queueOk({ message_id: 73 });
      queueOk({ message_id: 74 });

      await service.sendToTopic(100, text);

      expect(fetchCalls.length).toBe(2);
    });
  });
});
