import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Mock external dependencies BEFORE importing the module under test
// ============================================================

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

// Mock the health monitor import used by handleHealth
mock.module('../plugins/itachi-tasks/workers/health-monitor.js', () => ({
  lastHealthStatus: {
    supabase: 'ok',
    machines: { online: 2, total: 3 },
    staleTasks: 0,
    memoryCount: 42,
    timestamp: Date.now(),
  },
}));

// Mock the brain-loop-service import used by handleBrain
const mockBrainConfig = {
  enabled: true,
  intervalMs: 300000,
  maxProposalsPerCycle: 3,
  dailyBudgetLimit: 50,
};
mock.module('../plugins/itachi-tasks/services/brain-loop-service.js', () => ({
  getConfig: () => ({ ...mockBrainConfig }),
  updateConfig: (patch: any) => Object.assign(mockBrainConfig, patch),
  getDailyStats: async () => ({ proposed: 5, approved: 3, rejected: 1, expired: 1 }),
  getPendingProposals: async () => [],
}));

// Mock github-sync
mock.module('../plugins/itachi-tasks/services/github-sync.js', () => ({
  syncGitHubRepos: async () => ({ synced: 3, total: 5, errors: [] }),
}));

// Mock interactive-session action
const mockInteractiveSessionHandler = mock(async () => ({ success: true }));
mock.module('../plugins/itachi-tasks/actions/interactive-session.js', () => ({
  interactiveSessionAction: {
    handler: mockInteractiveSessionHandler,
  },
  wrapStreamJsonInput: (text: string) => JSON.stringify({ type: 'input', text }) + '\n',
}));

// Mock directory-browser
mock.module('../plugins/itachi-tasks/utils/directory-browser.js', () => ({
  listRemoteDirectory: async () => [],
  browsingSessionMap: new Map(),
}));

// Mock active-sessions
const mockActiveSessions = new Map<number, any>();
const closedSessions = new Set<number>();
const mockSpawningTopics = new Set<number>();
mock.module('../plugins/itachi-tasks/shared/active-sessions.js', () => ({
  activeSessions: mockActiveSessions,
  markSessionClosed: (id: number) => closedSessions.add(id),
  isSessionTopic: (id: number) => closedSessions.has(id),
  spawningTopics: mockSpawningTopics,
  suppressNextLLMMessage: () => {},
}));

// Mock conversation-flows
const mockFlows = new Map<string, any>();
mock.module('../plugins/itachi-tasks/shared/conversation-flows.js', () => ({
  getFlow: (chatId: number) => {
    for (const [, flow] of mockFlows) {
      if (flow.chatId === chatId) return flow;
    }
    return undefined;
  },
  setFlow: (chatId: number, userId: number, flow: any) => {
    mockFlows.set(`${chatId}-${userId}`, flow);
  },
  clearFlow: () => {},
  cleanupStaleFlows: () => {},
  flowKey: (chatId: number, userId: number) => `${chatId}-${userId}`,
  conversationFlows: mockFlows,
}));

// Mock start-dir
mock.module('../plugins/itachi-tasks/shared/start-dir.js', () => ({
  getStartingDir: () => '/home/user',
}));

// Import the module under test AFTER mocks
import { telegramCommandsAction } from '../plugins/itachi-tasks/actions/telegram-commands';

// ============================================================
// Test helpers
// ============================================================

interface MockService {
  [key: string]: any;
}

function makeServices(overrides: Record<string, MockService> = {}) {
  const defaults: Record<string, MockService> = {
    'itachi-memory': {
      searchMemories: mock(async () => []),
      storeMemory: mock(async () => ({ id: 'mem-1' })),
      reinforceMemory: mock(async () => true),
      deleteMemory: mock(async () => true),
    },
    'itachi-tasks': {
      listTasks: mock(async () => []),
      getMergedRepos: mock(async () => [
        { name: 'my-app', url: 'https://github.com/user/my-app' },
      ]),
      getTaskByPrefix: mock(async () => null),
      getSupabase: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({ not: () => ({ limit: () => ({ data: [], error: null }) }) }),
            in: () => ({ limit: () => ({ data: [], error: null }) }),
            ilike: () => ({ limit: () => ({ single: () => ({ data: null, error: { message: 'not found' } }) }) }),
            neq: () => ({ eq: () => ({ limit: () => ({ data: [] }) }) }),
            limit: () => ({ single: () => ({ data: null, error: { message: 'not found' } }) }),
            not: () => ({ limit: () => ({ data: [] }) }),
          }),
          update: () => ({ eq: () => ({ data: null, error: null }) }),
        }),
      }),
    },
    'machine-registry': {
      getAllMachines: mock(async () => [
        {
          machine_id: 'itachi-m1',
          display_name: 'air',
          status: 'online',
          os: 'darwin',
          active_tasks: 0,
          max_concurrent: 3,
          projects: ['itachi-memory'],
          engine_priority: ['claude', 'gemini'],
        },
      ]),
      resolveMachine: mock(async (id: string) => ({
        machine: { machine_id: id, display_name: id },
      })),
      updateEnginePriority: mock(async (id: string, engines: string[]) => ({
        machine_id: id,
        display_name: id,
        engine_priority: engines,
      })),
    },
    'telegram-topics': {
      chatId: -1001234567890,
      sendToTopic: mock(async () => {}),
      closeTopic: mock(async () => true),
      forceDeleteTopic: mock(async () => true),
      unregisterTopic: mock(async () => {}),
      sendMessageWithKeyboard: mock(async () => ({ messageId: 123 })),
      getRegisteredTopicIds: mock(async () => new Set<number>()),
    },
    'ssh': {
      getTargets: mock(() => new Map([
        ['mac', { host: '100.0.0.1', user: 'user' }],
        ['windows', { host: '100.0.0.2', user: 'admin' }],
      ])),
    },
    'task-executor': {
      getActiveTaskInfo: mock(() => null),
    },
    'itachi-subagents': {
      spawn: mock(async () => ({ id: 'run-abc12345', execution_mode: 'local', agent_profile_id: 'reviewer' })),
      executeLocal: mock(async () => {}),
      getRecentRuns: mock(async () => []),
    },
    'itachi-agent-messages': {
      sendMessage: mock(async () => ({ id: 'msg-1' })),
    },
  };

  const merged = { ...defaults, ...overrides };
  return merged;
}

function makeRuntime(services: Record<string, MockService> = makeServices()) {
  return {
    agentId: 'test-agent',
    getService: (name: string) => services[name] ?? null,
    getRoom: async (id: string) => ({
      channelId: null,
      metadata: {},
    }),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    getSetting: () => null,
    useModel: mock(async () => 'project_rule'),
  } as any;
}

function makeMessage(text: string, source: string = 'telegram', extras: Record<string, any> = {}): any {
  return {
    content: { text, source, ...extras },
    roomId: 'room-1',
  };
}

function makeCallback(): [any, any[]] {
  const calls: any[] = [];
  const cb = mock(async (response: any) => {
    calls.push(response);
  });
  return [cb, calls];
}

// ============================================================
// Tests
// ============================================================

describe('telegramCommandsAction', () => {
  let services: Record<string, MockService>;
  let runtime: any;

  beforeEach(() => {
    services = makeServices();
    runtime = makeRuntime(services);
    mockActiveSessions.clear();
    closedSessions.clear();
    mockSpawningTopics.clear();
    mockFlows.clear();
    mockInteractiveSessionHandler.mockReset();
    mockInteractiveSessionHandler.mockImplementation(async () => ({ success: true }));
  });

  // ============================================================
  // validate() — command routing
  // ============================================================

  describe('validate() — command routing', () => {
    it('/help returns true', async () => {
      const msg = makeMessage('/help');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/recall <query> returns true', async () => {
      const msg = makeMessage('/recall auth middleware');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/repos returns true', async () => {
      const msg = makeMessage('/repos');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/machines returns true', async () => {
      const msg = makeMessage('/machines');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/machines with subcommand returns true', async () => {
      const msg = makeMessage('/machines engines');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/engines returns true', async () => {
      const msg = makeMessage('/engines');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/engines with args returns true', async () => {
      const msg = makeMessage('/engines itachi-m1 claude,gemini');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/health returns true', async () => {
      const msg = makeMessage('/health');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/brain returns true', async () => {
      const msg = makeMessage('/brain');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/brain with subcommand returns true', async () => {
      const msg = makeMessage('/brain on');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/session (no args) returns true', async () => {
      const msg = makeMessage('/session');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/session <target> returns true', async () => {
      const msg = makeMessage('/session mac');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/session <target> <prompt> returns true', async () => {
      const msg = makeMessage('/session mac fix the build');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/close returns true', async () => {
      const msg = makeMessage('/close');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/close with args returns true', async () => {
      const msg = makeMessage('/close done');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/deletetopic returns true', async () => {
      const msg = makeMessage('/deletetopic');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/delete_topic returns true', async () => {
      const msg = makeMessage('/delete_topic');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/delete-topic returns true', async () => {
      const msg = makeMessage('/delete-topic');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/deletetopic <id> returns true', async () => {
      const msg = makeMessage('/deletetopic 12345');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/deletetopics returns true', async () => {
      const msg = makeMessage('/deletetopics');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/deletetopics done returns true', async () => {
      const msg = makeMessage('/deletetopics done');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/delete_topics returns true', async () => {
      const msg = makeMessage('/delete_topics');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/delete returns true', async () => {
      const msg = makeMessage('/delete');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/delete done returns true', async () => {
      const msg = makeMessage('/delete done');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/feedback returns true', async () => {
      const msg = makeMessage('/feedback');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/feedback with args returns true', async () => {
      const msg = makeMessage('/feedback abc123 good nice work');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/learn <instruction> returns true', async () => {
      const msg = makeMessage('/learn always run tests before pushing');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/teach <instruction> returns true', async () => {
      const msg = makeMessage('/teach I prefer concise responses');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/unteach <query> returns true', async () => {
      const msg = makeMessage('/unteach always use bun');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/forget <query> returns true', async () => {
      const msg = makeMessage('/forget always use bun');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/spawn <profile> <task> returns true', async () => {
      const msg = makeMessage('/spawn code-reviewer review auth module');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/agents returns true', async () => {
      const msg = makeMessage('/agents');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/agents with subcommand returns true', async () => {
      const msg = makeMessage('/agents msg abc hello');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/msg <id> <message> returns true', async () => {
      const msg = makeMessage('/msg abc123 hello there');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/sync-repos returns true', async () => {
      const msg = makeMessage('/sync-repos');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/sync_repos returns true', async () => {
      const msg = makeMessage('/sync_repos');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/syncrepos returns true', async () => {
      const msg = makeMessage('/syncrepos');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/close_all_topics returns true', async () => {
      const msg = makeMessage('/close_all_topics');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/closealltopics returns true', async () => {
      const msg = makeMessage('/closealltopics');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/close-all-topics returns true', async () => {
      const msg = makeMessage('/close-all-topics');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/close_all returns true', async () => {
      const msg = makeMessage('/close_all');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/taskstatus returns true', async () => {
      const msg = makeMessage('/taskstatus');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/taskstatus <id> returns true', async () => {
      const msg = makeMessage('/taskstatus abc12345');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('/task <name> (single word, interactive flow) returns true', async () => {
      const msg = makeMessage('/task fix-auth');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    // ── Negative cases ──

    it('plain text returns false (no active flow)', async () => {
      const msg = makeMessage('just some text');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(false);
    });

    it('empty text returns false', async () => {
      const msg = makeMessage('');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(false);
    });

    it('just a slash returns false', async () => {
      const msg = makeMessage('/');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(false);
    });

    it('unknown command /foobar returns false', async () => {
      const msg = makeMessage('/foobar');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(false);
    });

    it('unknown command /randomcommand returns false', async () => {
      const msg = makeMessage('/randomcommand with args');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(false);
    });

    it('bot mention is stripped: /help@botname returns true', async () => {
      const msg = makeMessage('/help@ItachiBot');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });

    it('bot mention is stripped: /recall@botname query returns true', async () => {
      const msg = makeMessage('/recall@ItachiBot auth changes');
      expect(await telegramCommandsAction.validate(runtime, msg)).toBe(true);
    });
  });

  // ============================================================
  // handler() — dispatch tests
  // ============================================================

  describe('handler() — /help', () => {
    it('responds with help text containing key commands', async () => {
      const msg = makeMessage('/help');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const text = calls[0].text as string;
      expect(text).toContain('/task');
      expect(text).toContain('/session');
      expect(text).toContain('/recall');
      expect(text).toContain('/machines');
      expect(text).toContain('/health');
      expect(text).toContain('/help');
      expect(text).toContain('/teach');
      expect(text).toContain('/unteach');
      expect(text).toContain('/spawn');
      expect(text).toContain('/agents');
      expect(text).toContain('/close');
      expect(text).toContain('/deletetopics');
      expect(text).toContain('/brain');
    });
  });

  describe('handler() — /recall', () => {
    it('calls memoryService.searchMemories with query', async () => {
      const searchMock = services['itachi-memory'].searchMemories;
      searchMock.mockImplementation(async () => [
        { id: 'm1', category: 'code_change', project: 'my-app', summary: 'Updated auth middleware', similarity: 0.92 },
      ]);

      const msg = makeMessage('/recall auth middleware');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(searchMock).toHaveBeenCalledWith('auth middleware', undefined, 5);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].text).toContain('Found 1 memories');
      expect(calls[0].text).toContain('auth middleware');
    });

    it('supports project:query syntax', async () => {
      const searchMock = services['itachi-memory'].searchMemories;
      searchMock.mockImplementation(async () => []);

      const msg = makeMessage('/recall myproject:auth flow');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(searchMock).toHaveBeenCalledWith('auth flow', 'myproject', 5);
      expect(calls[0].text).toContain('No memories found in myproject');
    });

    it('returns empty when no results', async () => {
      const msg = makeMessage('/recall nonexistent thing');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('No memories found');
    });

    it('returns error when memory service unavailable', async () => {
      const svc = makeServices();
      delete (svc as any)['itachi-memory'];
      const rt = makeRuntime(svc);

      const msg = makeMessage('/recall test');
      const [cb, calls] = makeCallback();

      const result = await telegramCommandsAction.handler(rt, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Memory service not available');
      expect(result).toEqual(expect.objectContaining({ success: false }));
    });
  });

  describe('handler() — /machines', () => {
    it('calls registry.getAllMachines and responds with machine list', async () => {
      const msg = makeMessage('/machines');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(services['machine-registry'].getAllMachines).toHaveBeenCalled();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const text = calls[0].text as string;
      expect(text).toContain('air');
      expect(text).toContain('itachi-m1');
      expect(text).toContain('online');
    });

    it('shows "no machines" when registry is empty', async () => {
      services['machine-registry'].getAllMachines.mockImplementation(async () => []);
      const msg = makeMessage('/machines');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('No machines registered');
    });

    it('returns error when machine registry unavailable', async () => {
      const svc = makeServices();
      delete (svc as any)['machine-registry'];
      const rt = makeRuntime(svc);

      const msg = makeMessage('/machines');
      const [cb, calls] = makeCallback();

      const result = await telegramCommandsAction.handler(rt, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Machine registry service not available');
      expect(result).toEqual(expect.objectContaining({ success: false }));
    });
  });

  describe('handler() — /repos', () => {
    it('calls taskService.getMergedRepos', async () => {
      const msg = makeMessage('/repos');
      const [cb, calls] = makeCallback();

      const result = await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(services['itachi-tasks'].getMergedRepos).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });
  });

  describe('handler() — /close', () => {
    it('in main chat with no topic context shows hint', async () => {
      const msg = makeMessage('/close');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].text).toContain('Use /close inside a topic');
    });
  });

  describe('handler() — /health', () => {
    it('responds with system health info', async () => {
      const msg = makeMessage('/health');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const text = calls[0].text as string;
      expect(text).toContain('System Health');
      expect(text).toContain('Supabase');
    });
  });

  describe('handler() — /brain', () => {
    it('/brain shows status', async () => {
      const msg = makeMessage('/brain');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      const text = calls[0].text as string;
      expect(text).toContain('Brain Loop');
      expect(text).toContain('Enabled');
    });

    it('/brain status shows status', async () => {
      const msg = makeMessage('/brain status');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      const text = calls[0].text as string;
      expect(text).toContain('Brain Loop');
    });
  });

  describe('handler() — /session', () => {
    it('/session <target> delegates to interactiveSessionAction', async () => {
      const msg = makeMessage('/session mac');
      const [cb] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(mockInteractiveSessionHandler).toHaveBeenCalled();
      // After delegation, _sessionSpawned flag should be set
      expect((msg.content as any)._sessionSpawned).toBe(true);
    });
  });

  describe('handler() — /feedback', () => {
    it('shows usage when no args provided', async () => {
      const msg = makeMessage('/feedback');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Usage: /feedback');
    });

    it('shows usage when format is wrong', async () => {
      const msg = makeMessage('/feedback abc123');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Usage: /feedback');
    });
  });

  describe('handler() — /learn', () => {
    it('stores a project_rule memory', async () => {
      const storeMock = services['itachi-memory'].storeMemory;
      const searchMock = services['itachi-memory'].searchMemories;
      searchMock.mockImplementation(async () => []);

      const msg = makeMessage('/learn always run tests before pushing');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(storeMock).toHaveBeenCalledWith(expect.objectContaining({
        project: 'general',
        category: 'project_rule',
        content: 'always run tests before pushing',
        summary: 'always run tests before pushing',
      }));
      expect(calls[0].text).toContain('Learned');
    });

    it('reinforces existing rule if similarity > 0.85', async () => {
      const searchMock = services['itachi-memory'].searchMemories;
      const reinforceMock = services['itachi-memory'].reinforceMemory;
      searchMock.mockImplementation(async () => [
        { id: 'existing-1', summary: 'always run tests before pushing', similarity: 0.90 },
      ]);

      const msg = makeMessage('/learn always run tests before push');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(reinforceMock).toHaveBeenCalledWith('existing-1', { confidence: 0.95 });
      expect(calls[0].text).toContain('Reinforced existing rule');
    });

    it('rejects too short instructions', async () => {
      const msg = makeMessage('/learn abc');
      const [cb, calls] = makeCallback();

      const result = await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Usage: /learn');
      expect(result).toEqual(expect.objectContaining({ success: false }));
    });
  });

  describe('handler() — /unteach and /forget', () => {
    it('/unteach deletes best matching memory', async () => {
      const searchMock = services['itachi-memory'].searchMemories;
      const deleteMock = services['itachi-memory'].deleteMemory;
      searchMock.mockImplementation(async () => [
        { id: 'rule-1', summary: 'always use bun', category: 'project_rule', similarity: 0.88 },
      ]);

      const msg = makeMessage('/unteach always use bun');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(deleteMock).toHaveBeenCalledWith('rule-1');
      expect(calls[0].text).toContain('Deleted project_rule');
    });

    it('/forget is an alias for /unteach', async () => {
      const searchMock = services['itachi-memory'].searchMemories;
      searchMock.mockImplementation(async () => [
        { id: 'rule-2', summary: 'prefer npm', category: 'project_rule', similarity: 0.85 },
      ]);

      const msg = makeMessage('/forget prefer npm');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(services['itachi-memory'].deleteMemory).toHaveBeenCalledWith('rule-2');
    });

    it('reports no matches found', async () => {
      const msg = makeMessage('/unteach something totally unrelated');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('No matching rules');
    });
  });

  describe('handler() — /engines', () => {
    it('/engines lists machine engine priorities', async () => {
      const msg = makeMessage('/engines');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(services['machine-registry'].getAllMachines).toHaveBeenCalled();
      expect(calls[0].text).toContain('engine priorities');
    });

    it('/engines <machine> <engines> updates engine priority', async () => {
      const msg = makeMessage('/engines itachi-m1 gemini,claude');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(services['machine-registry'].updateEnginePriority).toHaveBeenCalledWith(
        'itachi-m1',
        ['gemini', 'claude']
      );
      expect(calls[0].text).toContain('Updated');
      expect(calls[0].text).toContain('gemini');
    });
  });

  describe('handler() — /sync-repos', () => {
    it('calls syncGitHubRepos and reports result', async () => {
      const msg = makeMessage('/sync-repos');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      // First call is "Syncing..." message, second is result
      expect(calls.length).toBe(2);
      expect(calls[0].text).toContain('Syncing');
      expect(calls[1].text).toContain('Synced 3/5');
    });
  });

  describe('handler() — /spawn', () => {
    it('spawns a subagent with correct profile and task', async () => {
      const msg = makeMessage('/spawn code-reviewer Review the auth module');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(services['itachi-subagents'].spawn).toHaveBeenCalledWith(expect.objectContaining({
        profileId: 'code-reviewer',
        task: 'Review the auth module',
        executionMode: 'local',
      }));
      expect(calls[0].text).toContain('Agent spawned');
    });

    it('shows usage when format is wrong', async () => {
      const msg = makeMessage('/spawn');
      const [cb, calls] = makeCallback();

      // /spawn with no args won't match validate, but handler can still be called
      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      // Falls through to "Unknown command" since /spawn alone doesn't match handler patterns
    });
  });

  describe('handler() — /agents', () => {
    it('shows "no runs found" when empty', async () => {
      const msg = makeMessage('/agents');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('No subagent runs found');
    });

    it('lists recent runs', async () => {
      services['itachi-subagents'].getRecentRuns.mockImplementation(async () => [
        { id: 'run-12345678-abcd', status: 'completed', agent_profile_id: 'reviewer', task: 'Review auth', created_at: new Date().toISOString() },
      ]);

      const msg = makeMessage('/agents');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Recent agent runs');
      expect(calls[0].text).toContain('reviewer');
    });
  });

  describe('handler() — session control commands', () => {
    it('/ctrl+c suppresses LLM with IGNORE', async () => {
      const msg = makeMessage('/ctrl+c');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0]).toEqual({ text: '', action: 'IGNORE' });
    });

    it('/esc suppresses LLM with IGNORE', async () => {
      const msg = makeMessage('/esc');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0]).toEqual({ text: '', action: 'IGNORE' });
    });

    it('/stop suppresses LLM with IGNORE', async () => {
      const msg = makeMessage('/stop');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0]).toEqual({ text: '', action: 'IGNORE' });
    });

    it('/yes suppresses LLM with IGNORE', async () => {
      const msg = makeMessage('/yes');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0]).toEqual({ text: '', action: 'IGNORE' });
    });

    it('/no suppresses LLM with IGNORE', async () => {
      const msg = makeMessage('/no');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0]).toEqual({ text: '', action: 'IGNORE' });
    });
  });

  describe('handler() — /taskstatus', () => {
    it('shows usage when no ID provided', async () => {
      const msg = makeMessage('/taskstatus');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Usage: /taskstatus');
    });

    it('shows "not found" for non-existent task', async () => {
      const msg = makeMessage('/taskstatus abc12345');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Task not found');
    });
  });

  describe('handler() — /deletetopics', () => {
    it('/deletetopics done calls handleDeleteTopics with "completed"', async () => {
      const msg = makeMessage('/deletetopics done');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      // Should attempt to query tasks with status=completed
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // With empty results, it says "No completed tasks with topics"
      expect(calls[0].text).toContain('completed');
    });

    it('/deletetopics failed calls handleDeleteTopics with "failed"', async () => {
      const msg = makeMessage('/deletetopics failed');
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('failed');
    });

    it('/deletetopics with invalid subcommand shows usage', async () => {
      const msg = makeMessage('/deletetopics badarg');
      const [cb, calls] = makeCallback();

      const result = await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0].text).toContain('Usage');
      expect(result).toEqual(expect.objectContaining({ success: false }));
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================

  describe('edge cases', () => {
    it('handler returns error for unknown /command', async () => {
      const msg = makeMessage('/unknowncommand');
      const [cb] = makeCallback();

      const result = await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(result).toEqual(expect.objectContaining({ success: false, error: 'Unknown command' }));
    });

    it('non-command text with _topicRelayQueued suppresses LLM', async () => {
      const msg = makeMessage('some text', 'telegram', { _topicRelayQueued: true });
      const [cb, calls] = makeCallback();

      await telegramCommandsAction.handler(runtime, msg, undefined, undefined, cb);

      expect(calls[0]).toEqual({ text: '', action: 'IGNORE' });
    });

    it('action has correct name', () => {
      expect(telegramCommandsAction.name).toBe('TELEGRAM_COMMANDS');
    });

    it('action has examples array', () => {
      expect(Array.isArray(telegramCommandsAction.examples)).toBe(true);
      expect(telegramCommandsAction.examples!.length).toBeGreaterThan(0);
    });

    it('action has similes array', () => {
      expect(Array.isArray(telegramCommandsAction.similes)).toBe(true);
      expect(telegramCommandsAction.similes!.length).toBeGreaterThan(0);
    });
  });
});
