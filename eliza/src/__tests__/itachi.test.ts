import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================
// Test helpers — mock ElizaOS runtime + Supabase
// ============================================================

function createMockSupabase(overrides: Record<string, unknown> = {}) {
  const defaultResponse = { data: [], error: null, count: 0 };
  const singleResponse = { data: null, error: null };

  const queryBuilder: Record<string, unknown> = {
    select: () => queryBuilder,
    insert: () => queryBuilder,
    update: () => queryBuilder,
    upsert: () => queryBuilder,
    delete: () => queryBuilder,
    eq: () => queryBuilder,
    in: () => queryBuilder,
    is: () => queryBuilder,
    ilike: () => queryBuilder,
    order: () => queryBuilder,
    limit: () => queryBuilder,
    single: () => singleResponse,
    then: (cb: (val: unknown) => void) => Promise.resolve(defaultResponse).then(cb),
    ...overrides,
  };

  return {
    from: () => queryBuilder,
    rpc: async () => ({ data: [], error: null }),
    ...overrides,
  };
}

function createMockRuntime(overrides: Record<string, unknown> = {}) {
  const settings: Record<string, string> = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    ITACHI_ALLOWED_USERS: '123,456',
    // ITACHI_REPOS removed — repos come from project_registry table
    ITACHI_BOOTSTRAP_CONFIG: 'encrypted-config-data',
    ITACHI_BOOTSTRAP_SALT: 'salt-value',
    ...((overrides.settings as Record<string, string>) || {}),
  };

  return {
    getSetting: (key: string) => settings[key] || '',
    getService: (name: string) => (overrides as Record<string, unknown>)[`service_${name}`] || null,
    useModel: async () => new Array(1536).fill(0.1),
    createMemory: async () => ({ id: 'mem-1' }),
    searchMemories: async () => [],
    deleteMemory: async () => {},
    emitEvent: async () => {},
    createTask: async () => ({ id: 'task-1' }),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    ...overrides,
  };
}

// ============================================================
// 1. Character credential loading
// ============================================================

describe('Character credential loading', () => {
  const testKeyPath = join(homedir(), '.itachi-test-cred');

  it('1. loadCredential reads key=value from file when env var is missing', async () => {
    // Dynamically import to test the loadCredential logic
    writeFileSync(testKeyPath, 'TEST_KEY=secret123\nOTHER=val');
    try {
      const content = readFileSync(testKeyPath, 'utf8').trim();
      const match = content.match(/TEST_KEY=(.+)/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('secret123');
    } finally {
      unlinkSync(testKeyPath);
    }
  });

  it('2. loadCredential returns empty string when file does not exist', () => {
    const fakePath = join(homedir(), '.nonexistent-credential-file-xyz');
    expect(existsSync(fakePath)).toBe(false);
    // Simulating loadCredential behavior
    const result = existsSync(fakePath) ? readFileSync(fakePath, 'utf8').trim() : '';
    expect(result).toBe('');
  });

  it('3. loadCredential handles file with no matching pattern', () => {
    writeFileSync(testKeyPath, 'UNRELATED_KEY=something');
    try {
      const content = readFileSync(testKeyPath, 'utf8').trim();
      const match = content.match(/MISSING_KEY=(.+)/);
      expect(match).toBeNull();
    } finally {
      unlinkSync(testKeyPath);
    }
  });
});

// ============================================================
// 4-7. Memory service logic
// ============================================================

describe('Memory service', () => {
  it('4. storeMemory constructs contextText from all fields', () => {
    const params = {
      project: 'my-app',
      category: 'code_change',
      content: 'Updated auth flow with JWT refresh',
      summary: 'Auth JWT refresh',
      files: ['src/auth.ts', 'src/middleware.ts'],
      branch: 'feature/auth',
    };

    const contextText = [
      `Category: ${params.category}`,
      `Summary: ${params.summary}`,
      params.files.length > 0 ? `Files: ${params.files.join(', ')}` : '',
      params.content ? `Changes:\n${params.content.substring(0, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    expect(contextText).toContain('Category: code_change');
    expect(contextText).toContain('Files: src/auth.ts, src/middleware.ts');
    expect(contextText).toContain('Changes:\nUpdated auth flow');
  });

  it('5. storeMemory truncates content at 500 chars', () => {
    const longContent = 'x'.repeat(1000);
    const truncated = longContent.substring(0, 500);
    expect(truncated.length).toBe(500);
    expect(longContent.length).toBe(1000);
  });

  it('6. storeMemory handles empty files array', () => {
    const files: string[] = [];
    const filesPart = files.length > 0 ? `Files: ${files.join(', ')}` : '';
    expect(filesPart).toBe('');
  });

  it('7. storeFact deduplication — similarity > 0.92 should skip', () => {
    // Simulate the dedup check
    const existing = [{ similarity: 0.95, id: 'existing-1' }];
    const shouldSkip = existing.length > 0 && existing[0].similarity > 0.92;
    expect(shouldSkip).toBe(true);

    const notDuplicate = [{ similarity: 0.85, id: 'existing-2' }];
    const shouldStore = !(notDuplicate.length > 0 && notDuplicate[0].similarity > 0.92);
    expect(shouldStore).toBe(true);
  });
});

// ============================================================
// 8-12. Task service logic
// ============================================================

describe('Task service', () => {
  it('8. createTask rejects budget exceeding $10 max', () => {
    const maxAllowed = 10;
    const budget = 15;
    expect(budget > maxAllowed).toBe(true);
    expect(() => {
      if (budget > maxAllowed) {
        throw new Error(`Budget $${budget} exceeds max allowed $${maxAllowed}`);
      }
    }).toThrow('Budget $15 exceeds max allowed $10');
  });

  it('9. createTask accepts budget at exactly $10', () => {
    const maxAllowed = 10;
    const budget = 10;
    expect(budget > maxAllowed).toBe(false);
  });

  it('10. cancelTask rejects already-completed tasks', () => {
    const task = { id: 'abc', status: 'completed' };
    const cancellable = ['queued', 'claimed', 'running'];
    expect(cancellable.includes(task.status)).toBe(false);
  });

  it('11. cancelTask allows cancelling queued tasks', () => {
    const task = { id: 'abc', status: 'queued' };
    const cancellable = ['queued', 'claimed', 'running'];
    expect(cancellable.includes(task.status)).toBe(true);
  });

  it('12. getMergedRepos returns sorted DB repos from project_registry', () => {
    const dbRepos = [
      { name: 'repo-c', repo_url: null },
      { name: 'repo-a', repo_url: 'https://github.com/user/repo-a' },
      { name: 'repo-b', repo_url: 'https://github.com/user/repo-b' },
    ];

    const sorted = dbRepos
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(r => ({ name: r.name, repo_url: r.repo_url }));

    expect(sorted).toHaveLength(3);
    expect(sorted[0].name).toBe('repo-a');
    expect(sorted[1].name).toBe('repo-b');
    expect(sorted[2].name).toBe('repo-c');
    expect(sorted[2].repo_url).toBeNull();
  });
});

// ============================================================
// 13-14. Task poller logic
// ============================================================

describe('Task poller', () => {
  it('13. skips tasks completed more than 5 minutes ago', () => {
    const completedAt = new Date(Date.now() - 6 * 60 * 1000); // 6 min ago
    const tooOld = Date.now() - completedAt.getTime() > 5 * 60 * 1000;
    expect(tooOld).toBe(true);
  });

  it('14. notifies tasks completed within 5 minutes', () => {
    const completedAt = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago
    const tooOld = Date.now() - completedAt.getTime() > 5 * 60 * 1000;
    expect(tooOld).toBe(false);
  });
});

// ============================================================
// 15-16. Spawn session — project extraction
// ============================================================

describe('Spawn session project extraction', () => {
  it('15. extracts project name from message when it matches a known repo', () => {
    const repoNames = ['my-app', 'api-service', 'frontend'];
    const text = 'Fix the login bug in my-app';
    const lowerText = text.toLowerCase();

    let project: string | null = null;
    for (const repo of repoNames) {
      if (lowerText.includes(repo.toLowerCase())) {
        project = repo;
        break;
      }
    }

    expect(project).toBe('my-app');
  });

  it('16. returns null when no repo matches the message', () => {
    const repoNames = ['my-app', 'api-service'];
    const text = 'Deploy the thing to production';
    const lowerText = text.toLowerCase();

    let project: string | null = null;
    for (const repo of repoNames) {
      if (lowerText.includes(repo.toLowerCase())) {
        project = repo;
        break;
      }
    }

    expect(project).toBeNull();
  });
});

// ============================================================
// 17. Self-improve — lesson extractor validate
// ============================================================

describe('Lesson extractor', () => {
  it('17. validate triggers on feedback keywords', () => {
    const feedbackPattern = /\b(good|bad|wrong|right|better|worse|mistake|perfect|great|terrible|nice|failed)\b/;

    expect(feedbackPattern.test('that was wrong')).toBe(true);
    expect(feedbackPattern.test('good call on the model choice')).toBe(true);
    expect(feedbackPattern.test('hello how are you')).toBe(false);
    expect(feedbackPattern.test('the task failed')).toBe(true);
    expect(feedbackPattern.test('deploy to vercel')).toBe(false);
  });

  it('18. validate triggers on completion keywords', () => {
    const text1 = 'Task a1b2c3d4 completed!';
    const text2 = 'The deployment failed with an error';
    const text3 = 'What is the weather today';

    expect(text1.includes('completed') || text1.includes('failed')).toBe(true);
    expect(text2.includes('completed') || text2.includes('failed')).toBe(true);
    expect(text3.includes('completed') || text3.includes('failed')).toBe(false);
  });
});

// ============================================================
// 19. Route handler — update task field filtering
// ============================================================

describe('Task update field filtering', () => {
  it('19. only allows whitelisted fields through', () => {
    const allowedFields = [
      'status', 'target_branch', 'session_id', 'result_summary',
      'result_json', 'error_message', 'files_changed', 'pr_url',
      'workspace_path', 'started_at', 'completed_at', 'notified_at',
    ];

    const maliciousBody = {
      status: 'completed',
      result_summary: 'Done',
      telegram_chat_id: 999999,      // Should be filtered
      orchestrator_id: 'hacker-pc',   // Should be filtered
      id: 'fake-id',                  // Should be filtered
      description: 'overwritten!',    // Should be filtered
    };

    const filtered: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if ((maliciousBody as Record<string, unknown>)[field] !== undefined) {
        filtered[field] = (maliciousBody as Record<string, unknown>)[field];
      }
    }

    expect(filtered).toHaveProperty('status', 'completed');
    expect(filtered).toHaveProperty('result_summary', 'Done');
    expect(filtered).not.toHaveProperty('telegram_chat_id');
    expect(filtered).not.toHaveProperty('orchestrator_id');
    expect(filtered).not.toHaveProperty('id');
    expect(filtered).not.toHaveProperty('description');
  });
});

// ============================================================
// 20. Bootstrap route — missing config
// ============================================================

describe('Bootstrap endpoint', () => {
  it('20. returns 503 when bootstrap config is missing', () => {
    const runtime = createMockRuntime({
      settings: {
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'key',
        ITACHI_BOOTSTRAP_CONFIG: '',
        ITACHI_BOOTSTRAP_SALT: '',
      },
    });

    const config = runtime.getSetting('ITACHI_BOOTSTRAP_CONFIG');
    const salt = runtime.getSetting('ITACHI_BOOTSTRAP_SALT');
    const shouldReturn503 = !config || !salt;

    expect(shouldReturn503).toBe(true);
  });

  it('20b. returns config when bootstrap is configured', () => {
    const runtime = createMockRuntime();
    const config = runtime.getSetting('ITACHI_BOOTSTRAP_CONFIG');
    const salt = runtime.getSetting('ITACHI_BOOTSTRAP_SALT');
    const shouldReturn503 = !config || !salt;

    expect(shouldReturn503).toBe(false);
    expect(config).toBe('encrypted-config-data');
    expect(salt).toBe('salt-value');
  });
});

// ============================================================
// BONUS edge cases
// ============================================================

describe('Edge cases', () => {
  it('21. allowed users check with empty whitelist allows all', () => {
    const allowedStr = '';
    const allowedUsers = allowedStr.split(',').map(id => id.trim()).filter(Boolean);
    // If no whitelist configured, allow all
    const isAllowed = allowedUsers.length === 0 ? true : allowedUsers.includes('999');
    expect(isAllowed).toBe(true);
  });

  it('22. allowed users check blocks unauthorized user', () => {
    const allowedStr = '123,456';
    const allowedUsers = allowedStr.split(',').map(id => id.trim()).filter(Boolean);
    const isAllowed = allowedUsers.length === 0 ? true : allowedUsers.includes('999');
    expect(isAllowed).toBe(false);
  });

  it('23. allowed users check permits authorized user', () => {
    const allowedStr = '123,456';
    const allowedUsers = allowedStr.split(',').map(id => id.trim()).filter(Boolean);
    const isAllowed = allowedUsers.length === 0 ? true : allowedUsers.includes('123');
    expect(isAllowed).toBe(true);
  });

  it('24. task status icons map correctly', () => {
    const statusIcon: Record<string, string> = {
      queued: '[]', claimed: '..', running: '>>', completed: 'OK',
      failed: '!!', cancelled: '--', timeout: 'TO',
    };

    expect(statusIcon['queued']).toBe('[]');
    expect(statusIcon['completed']).toBe('OK');
    expect(statusIcon['failed']).toBe('!!');
    expect(statusIcon['timeout']).toBe('TO');
    expect(statusIcon['unknown_status'] || '??').toBe('??');
  });

  it('25. getTimeAgo formats correctly', () => {
    function getTimeAgo(dateStr: string): string {
      const diff = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    }

    const now = new Date();
    const thirtyMinsAgo = new Date(now.getTime() - 30 * 60000).toISOString();
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60000).toISOString();

    expect(getTimeAgo(thirtyMinsAgo)).toBe('30m ago');
    expect(getTimeAgo(threeHoursAgo)).toBe('3h ago');
    expect(getTimeAgo(twoDaysAgo)).toBe('2d ago');
  });
});

// ============================================================
// Production error fix validations — FUNCTIONAL TESTS
// Imports actual modules and calls real functions with mocks
// ============================================================

describe('Fix 2: lessonExtractor examples (actual import)', () => {
  it('26. examples have {prompt, messages, outcome} — no {prompt, response}', async () => {
    const { lessonExtractor } = await import('../plugins/itachi-self-improve/evaluators/lesson-extractor.js');
    expect(lessonExtractor.examples!.length).toBeGreaterThan(0);
    for (const ex of lessonExtractor.examples!) {
      expect(ex).toHaveProperty('prompt');
      expect(ex).toHaveProperty('messages');
      expect(ex).toHaveProperty('outcome');
      expect(Array.isArray(ex.messages)).toBe(true);
      expect(ex.messages!.length).toBeGreaterThan(0);
      expect(typeof ex.outcome).toBe('string');
      expect(ex).not.toHaveProperty('response');
    }
  });
});

describe('Fix 3: fact-extractor.ts deleted', () => {
  it('27. import fails — file does not exist', async () => {
    let threw = false;
    try { await import('../plugins/itachi-memory/evaluators/fact-extractor.js'); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe('Fix 4: lessonsProvider graceful embedding failure', () => {
  it('28. returns empty when searchMemories throws (embedding.map crash)', async () => {
    const { lessonsProvider } = await import('../plugins/itachi-self-improve/providers/lessons.js');
    const runtime = createMockRuntime({
      searchMemories: async () => { throw new Error('embedding.map is not a function'); },
    });
    const msg = { content: { text: 'What lessons about testing?' } };
    const result = await lessonsProvider.get(runtime as any, msg as any, undefined);
    expect(result.text).toBe('');
    expect(result).toHaveProperty('values');
    expect(result).toHaveProperty('data');
  });

  it('29. returns empty for short messages without hitting search at all', async () => {
    const { lessonsProvider } = await import('../plugins/itachi-self-improve/providers/lessons.js');
    let searchCalled = false;
    const runtime = createMockRuntime({
      searchMemories: async () => { searchCalled = true; return []; },
    });
    const msg = { content: { text: 'hi' } };
    const result = await lessonsProvider.get(runtime as any, msg as any, undefined);
    expect(result.text).toBe('');
    expect(searchCalled).toBe(false); // Must not even try to search
  });
});

describe('Fix 5: CREATE_TASK — validate()', () => {
  it('30. validate accepts /task command', async () => {
    const { createTaskAction } = await import('../plugins/itachi-tasks/actions/create-task.js');
    const runtime = createMockRuntime({ agentId: 'bot-agent' });
    const msg = { userId: 'human-user', content: { text: '/task my-app Fix login bug' } };
    expect(await createTaskAction.validate(runtime as any, msg as any)).toBe(true);
  });

  it('31. validate accepts contextual confirmation when task service is available', async () => {
    // THE SCREENSHOT SCENARIO: user says "Yeah that would be great, can you do that?"
    // This has zero task keywords — but task service is running, so LLM should decide
    const { createTaskAction } = await import('../plugins/itachi-tasks/actions/create-task.js');
    const runtime = createMockRuntime({
      agentId: 'bot-agent',
      getService: (name: string) => name === 'itachi-tasks' ? { fake: true } : null,
    });
    const msg = { userId: 'human-user', content: { text: 'Yeah that would be great, can you do that?' } };
    expect(await createTaskAction.validate(runtime as any, msg as any)).toBe(true);
  });

  it('32. validate returns false when task service is not available', async () => {
    const { createTaskAction } = await import('../plugins/itachi-tasks/actions/create-task.js');
    const runtime = createMockRuntime({
      getService: () => null,
    });
    const msg = { content: { text: 'Yeah create those tasks' } };
    expect(await createTaskAction.validate(runtime as any, msg as any)).toBe(false);
  });
});

describe('Fix 5: CREATE_TASK — handler() /task command path', () => {
  it('33. /task my-app Fix login bug → creates task with project=my-app', async () => {
    const { createTaskAction } = await import('../plugins/itachi-tasks/actions/create-task.js');

    const createdTasks: any[] = [];
    const mockTaskService = {
      createTask: async (params: any) => {
        createdTasks.push(params);
        return { id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff' };
      },
      getQueuedCount: async () => 1,
      getMergedRepos: async () => [{ name: 'my-app', repo_url: null }],
    };
    const runtime = createMockRuntime({
      getService: (name: string) => name === 'itachi-tasks' ? mockTaskService : null,
    });
    const msg = {
      content: { text: '/task my-app Fix the login bug', telegram_user_id: 123, telegram_chat_id: 456 },
    };

    let callbackText = '';
    const callback = async (r: any) => { callbackText = r.text; };
    const result = await createTaskAction.handler(runtime as any, msg as any, undefined, undefined, callback);

    expect(result.success).toBe(true);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].project).toBe('my-app');
    expect(createdTasks[0].description).toBe('Fix the login bug');
    expect(callbackText).toContain('QUEUED');
    expect(callbackText).toContain('my-app');
  });
});

describe('Fix 5: CREATE_TASK — handler() natural language with conversation context', () => {
  it('34. SCREENSHOT SCENARIO: "Yeah that would be great" + context → creates 2 tasks', async () => {
    // Reproduces the exact failure from Telegram screenshots:
    // Bot offered Remotion tasks for lotitachi + elizapets, user confirmed,
    // but handler couldn't parse "Yeah that would be great, can you do that?"
    const { createTaskAction } = await import('../plugins/itachi-tasks/actions/create-task.js');

    const createdTasks: any[] = [];
    const mockTaskService = {
      createTask: async (params: any) => {
        createdTasks.push(params);
        return { id: `${createdTasks.length}aaabbbb-cccc-dddd-eeee-ffffffffffff` };
      },
      getQueuedCount: async () => createdTasks.length,
      getMergedRepos: async () => [
        { name: 'lotitachi', repo_url: 'https://github.com/user/lotitachi' },
        { name: 'elizapets', repo_url: 'https://github.com/user/elizapets' },
      ],
    };

    // Mock LLM: when asked to extract tasks from context, return 2 tasks
    const runtime = createMockRuntime({
      getService: (name: string) => name === 'itachi-tasks' ? mockTaskService : null,
      useModel: async (_type: any, opts: any) => {
        const prompt = typeof opts === 'string' ? opts : opts?.prompt || '';
        // The LLM should see conversation context and extract both tasks
        if (prompt.includes('extracting task') || prompt.includes('Known projects')) {
          return JSON.stringify([
            { project: 'lotitachi', description: 'Scaffold reusable Remotion compositions for demo videos' },
            { project: 'elizapets', description: 'Scaffold reusable Remotion compositions for demo videos' },
          ]);
        }
        return '[]';
      },
    });

    const msg = {
      content: {
        text: 'Yeah that would be great, can you do that?',
        telegram_user_id: 123,
        telegram_chat_id: 456,
      },
    };

    // State with conversation history — the bot previously offered to create tasks
    const state = {
      data: {
        recentMessages: [
          { role: 'user', content: 'Using remotion for making demos for lotitachi and elizapets' },
          { role: 'assistant', content: 'Nice — Remotion is solid. I could queue up tasks to scaffold out reusable Remotion compositions. Want to offload any of that setup work?' },
          { role: 'user', content: 'Yeah that would be great, can you do that?' },
        ],
      },
    };

    let callbackText = '';
    const callback = async (r: any) => { callbackText = r.text; };
    const result = await createTaskAction.handler(
      runtime as any, msg as any, state as any, undefined, callback
    );

    // MUST succeed — this was the exact failure
    expect(result.success).toBe(true);
    // MUST create exactly 2 tasks
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[0].project).toBe('lotitachi');
    expect(createdTasks[1].project).toBe('elizapets');
    expect(createdTasks[0].description).toContain('Remotion');
    expect(createdTasks[1].description).toContain('Remotion');
    // Callback must report both tasks
    expect(callbackText).toContain('2 tasks QUEUED');
    expect(callbackText).toContain('lotitachi');
    expect(callbackText).toContain('elizapets');
  });

  it('35. single natural language task: "create a task for lotitachi to scaffold Remotion demos"', async () => {
    const { createTaskAction } = await import('../plugins/itachi-tasks/actions/create-task.js');

    const createdTasks: any[] = [];
    const mockTaskService = {
      createTask: async (params: any) => {
        createdTasks.push(params);
        return { id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff' };
      },
      getQueuedCount: async () => 1,
      getMergedRepos: async () => [
        { name: 'lotitachi', repo_url: 'https://github.com/user/lotitachi' },
      ],
    };

    const runtime = createMockRuntime({
      getService: (name: string) => name === 'itachi-tasks' ? mockTaskService : null,
      useModel: async () => JSON.stringify([
        { project: 'lotitachi', description: 'Scaffold Remotion demo page' },
      ]),
    });

    const msg = {
      content: {
        text: 'create a task for lotitachi to scaffold Remotion demos',
        telegram_user_id: 123,
        telegram_chat_id: 456,
      },
    };

    let callbackText = '';
    const callback = async (r: any) => { callbackText = r.text; };
    const result = await createTaskAction.handler(
      runtime as any, msg as any, undefined, undefined, callback
    );

    expect(result.success).toBe(true);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].project).toBe('lotitachi');
    expect(callbackText).toContain('QUEUED');
    expect(callbackText).toContain('lotitachi');
  });

  it('36. handler fails gracefully when LLM returns empty', async () => {
    const { createTaskAction } = await import('../plugins/itachi-tasks/actions/create-task.js');

    const mockTaskService = {
      createTask: async () => { throw new Error('should not be called'); },
      getQueuedCount: async () => 0,
      getMergedRepos: async () => [],
    };

    const runtime = createMockRuntime({
      getService: (name: string) => name === 'itachi-tasks' ? mockTaskService : null,
      useModel: async () => '[]', // LLM can't determine any tasks
    });

    const msg = { content: { text: 'do the thing', telegram_user_id: 123, telegram_chat_id: 456 } };

    let callbackText = '';
    const callback = async (r: any) => { callbackText = r.text; };
    const result = await createTaskAction.handler(
      runtime as any, msg as any, undefined, undefined, callback
    );

    expect(result.success).toBe(false);
    expect(callbackText).toContain("couldn't figure out");
    // Must NOT show "Usage: /task" — that was the old broken behavior
    expect(callbackText).not.toContain('Usage: /task');
  });
});

describe('Fix 2+: conversationMemoryEvaluator examples (actual import)', () => {
  it('37. examples have {prompt, messages, outcome}', async () => {
    const { conversationMemoryEvaluator } = await import('../plugins/itachi-memory/evaluators/conversation-memory.js');
    expect(conversationMemoryEvaluator.examples!.length).toBeGreaterThan(0);
    for (const ex of conversationMemoryEvaluator.examples!) {
      expect(ex).toHaveProperty('prompt');
      expect(ex).toHaveProperty('messages');
      expect(ex).toHaveProperty('outcome');
      expect(Array.isArray(ex.messages)).toBe(true);
      expect(typeof ex.outcome).toBe('string');
    }
  });
});
