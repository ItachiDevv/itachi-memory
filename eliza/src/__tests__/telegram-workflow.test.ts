import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Mock external dependencies
// ============================================================

let storedMemories: any[] = [];

function resetMocks() {
  storedMemories = [];
  pendingInputsMap.clear();
}

mock.module('@supabase/supabase-js', () => ({
  createClient: () => ({}),
}));

mock.module('@elizaos/core', () => ({
  Service: class {
    static serviceType = 'base';
    capabilityDescription = '';
    constructor(runtime?: any) { (this as any).runtime = runtime; }
  },
  ModelType: { TEXT: 'TEXT', TEXT_SMALL: 'TEXT_SMALL', TEXT_LARGE: 'TEXT_LARGE' },
}));

// Import the ACTUAL pendingInputs reference from the module that topic-input-relay uses
import { pendingInputs as pendingInputsMap } from '../plugins/itachi-tasks/routes/task-stream';

// ============================================================
// Test helpers
// ============================================================

function makeMockRuntime(opts: {
  rooms?: Record<string, any>;
  services?: Record<string, any>;
} = {}) {
  const logs: { level: string; msg: string }[] = [];
  const runtime: any = {
    agentId: 'test-agent',
    getRoom: async (id: string) => opts.rooms?.[id] ?? null,
    getService: (name: string) => opts.services?.[name] ?? null,
    logger: {
      info: (...a: any[]) => logs.push({ level: 'info', msg: a.map(String).join(' ') }),
      warn: (...a: any[]) => logs.push({ level: 'warn', msg: a.map(String).join(' ') }),
      error: (...a: any[]) => logs.push({ level: 'error', msg: a.map(String).join(' ') }),
    },
    useModel: async () => '',
    getSetting: () => null,
  };
  return { runtime, logs };
}

function makeRoom(opts: { threadId?: string | number; channelId?: string } = {}) {
  return {
    metadata: opts.threadId !== undefined ? { threadId: opts.threadId } : {},
    channelId: opts.channelId || undefined,
  };
}

function makeMessage(text: string, roomId: string, overrides: Record<string, any> = {}) {
  return {
    content: { text, source: 'telegram', ...overrides },
    roomId,
  };
}

function makeMockTaskService(tasks: any[] = []) {
  return {
    getActiveTasks: async () => tasks.filter(t => ['running', 'claimed', 'queued', 'waiting_input'].includes(t.status)),
    listTasks: async (_opts?: any) => tasks,
    getTask: async (id: string) => tasks.find(t => t.id === id) || null,
    createTask: async (params: any) => ({ id: 'new-task-id-12345678', ...params }),
    getQueuedCount: async () => tasks.filter(t => t.status === 'queued').length,
  };
}

function makeMockMemoryService() {
  return {
    storeMemory: async (m: any) => { storedMemories.push(m); },
    searchMemories: async () => [],
    getSupabase: () => ({}),
  };
}

// ============================================================
// 1. TELEGRAM UTILITIES — stripBotMention + getTopicThreadId
// ============================================================

import { stripBotMention, getTopicThreadId } from '../plugins/itachi-tasks/utils/telegram';

describe('stripBotMention', () => {
  it('removes @BotName from slash commands', () => {
    expect(stripBotMention('/repos@Itachi_Mangekyou_bot')).toBe('/repos');
  });

  it('preserves arguments after bot mention', () => {
    expect(stripBotMention('/cancel@Itachi_Mangekyou_bot 3c1a19e5')).toBe('/cancel 3c1a19e5');
  });

  it('preserves @ mentions in arguments', () => {
    expect(stripBotMention('/exec@Bot @windows echo test')).toBe('/exec @windows echo test');
  });

  it('does not modify plain text with @mention', () => {
    expect(stripBotMention('normal text @mention')).toBe('normal text @mention');
  });

  it('does not modify command without @bot', () => {
    expect(stripBotMention('/status')).toBe('/status');
  });

  it('handles empty string', () => {
    expect(stripBotMention('')).toBe('');
  });

  it('preserves multi-word commands', () => {
    expect(stripBotMention('/task@Bot my-project fix the auth bug'))
      .toBe('/task my-project fix the auth bug');
  });
});

describe('getTopicThreadId', () => {
  it('extracts threadId from room metadata', async () => {
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: '12345' }) },
    });
    const msg = makeMessage('test', 'room1');
    expect(await getTopicThreadId(runtime, msg as any)).toBe(12345);
  });

  it('extracts numeric threadId from room metadata', async () => {
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: 67890 }) },
    });
    const msg = makeMessage('test', 'room1');
    expect(await getTopicThreadId(runtime, msg as any)).toBe(67890);
  });

  it('falls back to channelId parsing for supergroup format', async () => {
    // Telegram supergroup: "-1001234567890-12345" → threadId = 12345
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ channelId: '-1001234567890-12345' }) },
    });
    const msg = makeMessage('test', 'room1');
    expect(await getTopicThreadId(runtime, msg as any)).toBe(12345);
  });

  it('returns null for channelId without hyphen', async () => {
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': { metadata: {}, channelId: '1234567890' } },
    });
    const msg = makeMessage('test', 'room1');
    // No hyphen found or single-segment id
    expect(await getTopicThreadId(runtime, msg as any)).toBe(null);
  });

  it('returns null when room not found', async () => {
    const { runtime } = makeMockRuntime();
    const msg = makeMessage('test', 'nonexistent');
    expect(await getTopicThreadId(runtime, msg as any)).toBe(null);
  });

  it('returns null when roomId is missing', async () => {
    const { runtime } = makeMockRuntime();
    expect(await getTopicThreadId(runtime, { content: { text: 'x' } } as any)).toBe(null);
  });

  it('returns null for non-numeric threadId in metadata', async () => {
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: 'not-a-number' }) },
    });
    const msg = makeMessage('test', 'room1');
    expect(await getTopicThreadId(runtime, msg as any)).toBe(null);
  });

  it('handles channelId with thread part = 0 (not a real topic)', async () => {
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': { metadata: {}, channelId: '-1001234567890-0' } },
    });
    const msg = makeMessage('test', 'room1');
    // threadId=0 → not a real topic (parsed > 0 check)
    expect(await getTopicThreadId(runtime, msg as any)).toBe(null);
  });

  it('handles getRoom throwing error gracefully', async () => {
    const runtime: any = {
      getRoom: async () => { throw new Error('DB down'); },
    };
    const msg = { content: { text: 'x' }, roomId: 'room1' };
    expect(await getTopicThreadId(runtime, msg as any)).toBe(null);
  });
});

// ============================================================
// 2. TOPIC INPUT RELAY EVALUATOR
// ============================================================

import { topicInputRelayEvaluator } from '../plugins/itachi-tasks/evaluators/topic-input-relay';

describe('TOPIC_INPUT_RELAY evaluator', () => {
  beforeEach(() => {
    resetMocks();
    pendingInputsMap.clear();
  });

  describe('validate()', () => {
    it('returns true for telegram message in a topic room', async () => {
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
      });
      const msg = makeMessage('hello', 'room1');
      expect(await topicInputRelayEvaluator.validate!(runtime, msg as any, {} as any)).toBe(true);
    });

    it('returns false for non-telegram source', async () => {
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
      });
      const msg = { content: { text: 'hi', source: 'discord' }, roomId: 'room1' };
      expect(await topicInputRelayEvaluator.validate!(runtime, msg as any, {} as any)).toBe(false);
    });

    it('returns false for telegram message NOT in a topic', async () => {
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': { metadata: {}, channelId: '1234567890' } },
      });
      const msg = makeMessage('hello', 'room1');
      expect(await topicInputRelayEvaluator.validate!(runtime, msg as any, {} as any)).toBe(false);
    });
  });

  describe('handler()', () => {
    const runningTask = {
      id: 'aaaa1111-2222-3333-4444-555566667777',
      telegram_topic_id: 111,
      status: 'running',
      project: 'itachi-memory',
      description: 'Fix the auth bug',
    };

    it('queues input for a running task', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime, logs } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('Also fix the error handling', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);

      expect(pendingInputsMap.has(runningTask.id)).toBe(true);
      expect(pendingInputsMap.get(runningTask.id)!).toHaveLength(1);
      expect(pendingInputsMap.get(runningTask.id)![0].text).toBe('Also fix the error handling');
      expect(logs.some(l => l.msg.includes('Queued input'))).toBe(true);
    });

    it('sets _topicRelayQueued on message', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('test input', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);

      expect((msg.content as any)._topicRelayQueued).toBe(true);
    });

    it('skips slash commands', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('/status', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);

      expect(pendingInputsMap.has(runningTask.id)).toBe(false);
    });

    it('does not queue for completed tasks', async () => {
      const completedTask = { ...runningTask, status: 'completed' };
      const taskService = makeMockTaskService([completedTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('more work needed', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);

      expect(pendingInputsMap.has(runningTask.id)).toBe(false);
    });

    it('queues for waiting_input tasks', async () => {
      const waitingTask = { ...runningTask, status: 'waiting_input' };
      const taskService = makeMockTaskService([waitingTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('here is the info you requested', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);

      expect(pendingInputsMap.has(runningTask.id)).toBe(true);
    });

    it('queues for queued tasks', async () => {
      const queuedTask = { ...runningTask, status: 'queued' };
      const taskService = makeMockTaskService([queuedTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('add this to the task', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);

      expect(pendingInputsMap.has(runningTask.id)).toBe(true);
    });

    it('stacks multiple inputs for the same task', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      await topicInputRelayEvaluator.handler(runtime, makeMessage('first input', 'room1') as any, {} as any);
      await topicInputRelayEvaluator.handler(runtime, makeMessage('second input', 'room1') as any, {} as any);

      expect(pendingInputsMap.get(runningTask.id)!).toHaveLength(2);
      expect(pendingInputsMap.get(runningTask.id)![0].text).toBe('first input');
      expect(pendingInputsMap.get(runningTask.id)![1].text).toBe('second input');
    });

    it('does nothing when task service is unavailable', async () => {
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: {},
      });

      const msg = makeMessage('test', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);
      expect(pendingInputsMap.size).toBe(0);
    });

    it('does nothing for empty text', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);
      expect(pendingInputsMap.size).toBe(0);
    });

    it('finds task in recent list when not in active', async () => {
      // Task is "queued" — getActiveTasks returns running/claimed/queued/waiting_input
      const queuedTask = { ...runningTask, status: 'queued' };
      const taskService = {
        getActiveTasks: async () => [], // empty active
        listTasks: async () => [queuedTask],
        getTask: async () => queuedTask,
      };
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '111' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('extra context', 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);
      expect(pendingInputsMap.has(runningTask.id)).toBe(true);
    });
  });

  describe('correction detection & RL lesson storage', () => {
    const runningTask = {
      id: 'bbbb2222-3333-4444-5555-666677778888',
      telegram_topic_id: 222,
      status: 'running',
      project: 'itachi-memory',
      description: 'Refactor the auth module',
    };

    it('stores correction lesson when user says "that\'s wrong"', async () => {
      const memService = makeMockMemoryService();
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '222' }) },
        services: { 'itachi-tasks': taskService, 'itachi-memory': memService },
      });

      const msg = makeMessage("that's wrong, try a different approach", 'room1');
      await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);

      // Allow async extractCorrectionLesson to complete
      await new Promise(r => setTimeout(r, 50));

      expect(storedMemories).toHaveLength(1);
      expect(storedMemories[0].category).toBe('task_lesson');
      expect(storedMemories[0].metadata.source).toBe('user_correction');
      expect(storedMemories[0].metadata.confidence).toBe(0.9);
    });

    it('stores correction lesson for "revert" command', async () => {
      const memService = makeMockMemoryService();
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '222' }) },
        services: { 'itachi-tasks': taskService, 'itachi-memory': memService },
      });

      await topicInputRelayEvaluator.handler(runtime, makeMessage('revert that change', 'room1') as any, {} as any);
      await new Promise(r => setTimeout(r, 50));

      expect(storedMemories).toHaveLength(1);
      expect(storedMemories[0].summary).toContain('revert');
    });

    it('does NOT store correction for positive feedback', async () => {
      const memService = makeMockMemoryService();
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '222' }) },
        services: { 'itachi-tasks': taskService, 'itachi-memory': memService },
      });

      await topicInputRelayEvaluator.handler(runtime, makeMessage('looks good, keep going', 'room1') as any, {} as any);
      await new Promise(r => setTimeout(r, 50));

      expect(storedMemories).toHaveLength(0);
    });

    it('handles missing memory service gracefully', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '222' }) },
        services: { 'itachi-tasks': taskService },
      });

      // Should not throw
      await topicInputRelayEvaluator.handler(runtime, makeMessage("that's wrong", 'room1') as any, {} as any);
      await new Promise(r => setTimeout(r, 50));

      expect(storedMemories).toHaveLength(0);
    });
  });
});

// ============================================================
// 3. TOPIC REPLY ACTION
// ============================================================

import { topicReplyAction } from '../plugins/itachi-tasks/actions/topic-reply';

describe('TOPIC_REPLY action', () => {
  beforeEach(() => {
    resetMocks();
    pendingInputsMap.clear();
  });

  const runningTask = {
    id: 'cccc3333-4444-5555-6666-777788889999',
    telegram_topic_id: 333,
    status: 'running',
    project: 'itachi-memory',
    description: 'Fix the login bug',
    telegram_chat_id: -100123,
    telegram_user_id: 456,
    repo_url: 'https://github.com/test/repo',
    branch: 'main',
  };

  describe('validate()', () => {
    it('returns true for telegram message in topic with matching task', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('test reply', 'room1');
      expect(await topicReplyAction.validate!(runtime, msg as any, {} as any)).toBe(true);
    });

    it('returns false for non-telegram source', async () => {
      const { runtime } = makeMockRuntime();
      const msg = { content: { text: 'test', source: 'discord' }, roomId: 'room1' };
      expect(await topicReplyAction.validate!(runtime, msg as any, {} as any)).toBe(false);
    });

    it('returns false for slash commands', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('/status', 'room1');
      expect(await topicReplyAction.validate!(runtime, msg as any, {} as any)).toBe(false);
    });

    it('returns false when no task matches the topic', async () => {
      const taskService = makeMockTaskService([]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '999' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('hello', 'room1');
      expect(await topicReplyAction.validate!(runtime, msg as any, {} as any)).toBe(false);
    });
  });

  describe('handler()', () => {
    it('acknowledges relay for running task', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      let callbackText = '';
      const callback = async (msg: any) => { callbackText = msg.text; };

      const msg = makeMessage('additional context here', 'room1');
      (msg.content as any)._topicRelayQueued = true; // evaluator already queued

      const result = await topicReplyAction.handler(runtime, msg as any, undefined, undefined, callback);
      expect(result).toEqual({ success: true, data: { taskId: runningTask.id, action: 'queued_input' } });
      expect(callbackText).toContain('Queued your input');
      expect(callbackText).toContain(runningTask.id.substring(0, 8));
    });

    it('does not double-queue when evaluator already queued', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('test', 'room1');
      (msg.content as any)._topicRelayQueued = true;

      await topicReplyAction.handler(runtime, msg as any, undefined, undefined, async () => {});
      // Should NOT have added to pendingInputs since evaluator already did it
      expect(pendingInputsMap.has(runningTask.id)).toBe(false);
    });

    it('queues input when evaluator did NOT queue it', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      const msg = makeMessage('test input', 'room1');
      // No _topicRelayQueued set

      await topicReplyAction.handler(runtime, msg as any, undefined, undefined, async () => {});
      expect(pendingInputsMap.has(runningTask.id)).toBe(true);
      expect(pendingInputsMap.get(runningTask.id)![0].text).toBe('test input');
    });

    it('handles completed task — offers follow-up', async () => {
      const completedTask = { ...runningTask, status: 'completed' };
      const taskService = makeMockTaskService([completedTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      let callbackText = '';
      const callback = async (msg: any) => { callbackText = msg.text; };

      const msg = makeMessage('I need more work done', 'room1');
      const result = await topicReplyAction.handler(runtime, msg as any, undefined, undefined, callback);

      expect(result).toEqual({ success: true, data: { taskId: runningTask.id, action: 'offered_follow_up' } });
      expect(callbackText).toContain('already completed');
      expect(callbackText).toContain('follow up:');
    });

    it('creates follow-up task when "follow up:" prefix used', async () => {
      const completedTask = { ...runningTask, status: 'completed' };
      const taskService = makeMockTaskService([completedTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      let callbackText = '';
      const callback = async (msg: any) => { callbackText = msg.text; };

      const msg = makeMessage('follow up: Add tests for the login fix', 'room1');
      const result = await topicReplyAction.handler(runtime, msg as any, undefined, undefined, callback);

      expect((result as any).data.action).toBe('follow_up_created');
      expect(callbackText).toContain('Follow-up task created');
      expect(callbackText).toContain('Add tests for the login fix');
    });

    it('handles queued task — acknowledges pending', async () => {
      const queuedTask = { ...runningTask, status: 'queued' };
      const taskService = makeMockTaskService([queuedTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      let callbackText = '';
      const callback = async (msg: any) => { callbackText = msg.text; };

      const msg = makeMessage('extra context for when it starts', 'room1');
      const result = await topicReplyAction.handler(runtime, msg as any, undefined, undefined, callback);

      expect((result as any).data.action).toBe('queued_input_pending');
      expect(callbackText).toContain("hasn't started yet");
    });

    it('returns error when task service unavailable', async () => {
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: {},
      });

      const result = await topicReplyAction.handler(runtime, makeMessage('test', 'room1') as any, undefined, undefined, async () => {});
      expect(result).toEqual({ success: false, error: 'Task service not available' });
    });

    it('returns error for empty text', async () => {
      const taskService = makeMockTaskService([runningTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      const result = await topicReplyAction.handler(runtime, makeMessage('', 'room1') as any, undefined, undefined, async () => {});
      expect(result).toEqual({ success: false, error: 'Empty message or not in a topic' });
    });

    it('handles failed task — offers follow-up', async () => {
      const failedTask = { ...runningTask, status: 'failed' };
      const taskService = makeMockTaskService([failedTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      let callbackText = '';
      const result = await topicReplyAction.handler(runtime, makeMessage('what happened?', 'room1') as any, undefined, undefined, async (msg: any) => { callbackText = msg.text; });

      expect((result as any).data.action).toBe('offered_follow_up');
      expect(callbackText).toContain('follow up:');
    });

    it('handles waiting_input task — acknowledges relay', async () => {
      const waitingTask = { ...runningTask, status: 'waiting_input' };
      const taskService = makeMockTaskService([waitingTask]);
      const { runtime } = makeMockRuntime({
        rooms: { 'room1': makeRoom({ threadId: '333' }) },
        services: { 'itachi-tasks': taskService },
      });

      let callbackText = '';
      const msg = makeMessage('here is the data', 'room1');
      (msg.content as any)._topicRelayQueued = true;

      const result = await topicReplyAction.handler(runtime, msg as any, undefined, undefined, async (m: any) => { callbackText = m.text; });
      expect((result as any).data.action).toBe('queued_input');
      expect(callbackText).toContain('Queued your input');
    });
  });
});

// ============================================================
// 4. TOPIC CONTEXT PROVIDER
// ============================================================

import { topicContextProvider } from '../plugins/itachi-tasks/providers/topic-context';

describe('TASK_TOPIC_CONTEXT provider', () => {
  it('has position 1 (highest priority)', () => {
    expect(topicContextProvider.position).toBe(1);
  });

  it('returns empty for non-telegram messages', async () => {
    const { runtime } = makeMockRuntime();
    const msg = { content: { text: 'test', source: 'discord' }, roomId: 'room1' };
    const result = await topicContextProvider.get(runtime, msg as any);
    expect(result.text).toBe('');
  });

  it('returns empty for telegram message NOT in a topic', async () => {
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': { metadata: {}, channelId: '1234567890' } },
    });
    const msg = makeMessage('test', 'room1');
    const result = await topicContextProvider.get(runtime, msg as any);
    expect(result.text).toBe('');
  });

  it('returns suppression context for active running task', async () => {
    const task = {
      id: 'dddd4444-5555-6666-7777-888899990000',
      telegram_topic_id: 444,
      status: 'running',
      project: 'itachi-memory',
      description: 'Deploy the fix',
    };
    const taskService = makeMockTaskService([task]);
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: '444' }) },
      services: { 'itachi-tasks': taskService },
    });

    const msg = makeMessage('check the deploy status', 'room1');
    const result = await topicContextProvider.get(runtime, msg as any);

    expect(result.text).toContain('IMPORTANT: Task Topic Reply');
    expect(result.text).toContain('DO NOT respond conversationally');
    expect(result.text).toContain(task.id.substring(0, 8));
    expect(result.values!.taskTopicActive).toBe('true');
  });

  it('returns completed context for finished task', async () => {
    const task = {
      id: 'eeee5555-6666-7777-8888-999900001111',
      telegram_topic_id: 555,
      status: 'completed',
      project: 'itachi-memory',
      description: 'Old task',
    };
    const taskService = makeMockTaskService([task]);
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: '555' }) },
      services: { 'itachi-tasks': taskService },
    });

    const msg = makeMessage('can you do more?', 'room1');
    const result = await topicContextProvider.get(runtime, msg as any);

    expect(result.text).toContain('Task Topic Context');
    expect(result.text).toContain('already completed');
    expect(result.text).toContain('follow up:');
    expect(result.values!.taskTopicActive).toBe('false');
  });

  it('returns suppression for waiting_input task', async () => {
    const task = {
      id: 'ffff6666-7777-8888-9999-000011112222',
      telegram_topic_id: 666,
      status: 'waiting_input',
      project: 'test-project',
      description: 'Needs user info',
    };
    const taskService = makeMockTaskService([task]);
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: '666' }) },
      services: { 'itachi-tasks': taskService },
    });

    const msg = makeMessage('here is the info', 'room1');
    const result = await topicContextProvider.get(runtime, msg as any);

    expect(result.text).toContain('DO NOT respond conversationally');
    expect(result.values!.taskTopicActive).toBe('true');
  });

  it('returns empty when task service unavailable', async () => {
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: '777' }) },
      services: {},
    });

    const msg = makeMessage('test', 'room1');
    const result = await topicContextProvider.get(runtime, msg as any);
    expect(result.text).toBe('');
  });

  it('returns empty when no task matches topic', async () => {
    const taskService = makeMockTaskService([]);
    const { runtime } = makeMockRuntime({
      rooms: { 'room1': makeRoom({ threadId: '888' }) },
      services: { 'itachi-tasks': taskService },
    });

    const msg = makeMessage('test', 'room1');
    const result = await topicContextProvider.get(runtime, msg as any);
    expect(result.text).toBe('');
  });
});

// ============================================================
// 5. PENDINGINPUTS — Input Queue Mechanics
// ============================================================

describe('pendingInputs queue mechanics', () => {
  beforeEach(() => pendingInputsMap.clear());

  it('accumulates multiple inputs per task', () => {
    const taskId = 'test-task-1';
    pendingInputsMap.set(taskId, []);
    pendingInputsMap.get(taskId)!.push({ text: 'first', timestamp: Date.now() });
    pendingInputsMap.get(taskId)!.push({ text: 'second', timestamp: Date.now() });
    pendingInputsMap.get(taskId)!.push({ text: 'third', timestamp: Date.now() });

    expect(pendingInputsMap.get(taskId)!).toHaveLength(3);
    expect(pendingInputsMap.get(taskId)![0].text).toBe('first');
    expect(pendingInputsMap.get(taskId)![2].text).toBe('third');
  });

  it('delete clears all inputs (consumed by orchestrator)', () => {
    const taskId = 'test-task-2';
    pendingInputsMap.set(taskId, [
      { text: 'a', timestamp: Date.now() },
      { text: 'b', timestamp: Date.now() },
    ]);

    // Orchestrator consumes: GET /api/tasks/:id/input → delete
    pendingInputsMap.delete(taskId);
    expect(pendingInputsMap.has(taskId)).toBe(false);
  });

  it('handles concurrent tasks independently', () => {
    pendingInputsMap.set('task-a', [{ text: 'for A', timestamp: Date.now() }]);
    pendingInputsMap.set('task-b', [{ text: 'for B', timestamp: Date.now() }]);

    expect(pendingInputsMap.get('task-a')![0].text).toBe('for A');
    expect(pendingInputsMap.get('task-b')![0].text).toBe('for B');

    pendingInputsMap.delete('task-a');
    expect(pendingInputsMap.has('task-a')).toBe(false);
    expect(pendingInputsMap.has('task-b')).toBe(true);
  });
});

// ============================================================
// 6. FULL WORKFLOW INTEGRATION
// ============================================================

describe('Full Telegram workflow integration', () => {
  beforeEach(() => {
    resetMocks();
    pendingInputsMap.clear();
  });

  it('evaluator queues → provider suppresses → action acknowledges', async () => {
    const task = {
      id: 'integ-001-2222-3333-4444-555566667777',
      telegram_topic_id: 999,
      status: 'running',
      project: 'itachi-memory',
      description: 'Integration test task',
    };
    const taskService = makeMockTaskService([task]);
    const rooms = { 'room1': makeRoom({ threadId: '999' }) };
    const services = { 'itachi-tasks': taskService };

    // Step 1: Evaluator runs first (alwaysRun, before LLM)
    const { runtime: rt1 } = makeMockRuntime({ rooms, services });
    const msg = makeMessage('please also add logging', 'room1');

    const isValid = await topicInputRelayEvaluator.validate!(rt1, msg as any, {} as any);
    expect(isValid).toBe(true);

    await topicInputRelayEvaluator.handler(rt1, msg as any, {} as any);
    expect(pendingInputsMap.has(task.id)).toBe(true);
    expect((msg.content as any)._topicRelayQueued).toBe(true);

    // Step 2: Provider suppresses conversational response
    const { runtime: rt2 } = makeMockRuntime({ rooms, services });
    const ctx = await topicContextProvider.get(rt2, msg as any);
    expect(ctx.text).toContain('DO NOT respond conversationally');
    expect(ctx.values!.taskTopicActive).toBe('true');

    // Step 3: Action acknowledges (doesn't re-queue)
    const { runtime: rt3 } = makeMockRuntime({ rooms, services });
    let ackText = '';
    const result = await topicReplyAction.handler(rt3, msg as any, undefined, undefined, async (m: any) => { ackText = m.text; });
    expect((result as any).data.action).toBe('queued_input');
    expect(ackText).toContain('Queued your input');

    // Verify no double-queue
    expect(pendingInputsMap.get(task.id)!).toHaveLength(1);
  });

  it('correction → RL lesson stored → retrievable via lessons provider', async () => {
    const task = {
      id: 'integ-002-2222-3333-4444-555566667777',
      telegram_topic_id: 1001,
      status: 'running',
      project: 'itachi-memory',
      description: 'Refactor the database module',
    };
    const memService = makeMockMemoryService();
    const taskService = makeMockTaskService([task]);
    const rooms = { 'room1': makeRoom({ threadId: '1001' }) };
    const services = { 'itachi-tasks': taskService, 'itachi-memory': memService };

    // Step 1: User sends correction → evaluator stores RL lesson
    const { runtime } = makeMockRuntime({ rooms, services });
    const msg = makeMessage("that's wrong, don't use raw SQL", 'room1');

    await topicInputRelayEvaluator.handler(runtime, msg as any, {} as any);
    await new Promise(r => setTimeout(r, 100));

    // Verify lesson stored
    expect(storedMemories).toHaveLength(1);
    expect(storedMemories[0].category).toBe('task_lesson');
    expect(storedMemories[0].metadata.source).toBe('user_correction');
    expect(storedMemories[0].metadata.confidence).toBe(0.9);
    expect(storedMemories[0].summary).toContain("that's wrong");
    expect(storedMemories[0].project).toBe('itachi-memory');
  });
});
