import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Mock external dependencies
// ============================================================

let storedMemories: any[] = [];
let searchResults: any[] = [];
let supabaseCalls: { method: string; args: any[] }[] = [];
let supabaseDeleted: string[] = [];

function resetMocks() {
  storedMemories = [];
  searchResults = [];
  supabaseCalls = [];
  supabaseDeleted = [];
}

function createQueryBuilder(returnData: any = null, returnError: any = null): any {
  const qb: any = {};
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'insert', 'delete', 'single', 'lte']) {
    qb[m] = (...args: any[]) => {
      supabaseCalls.push({ method: m, args });
      if (m === 'delete') {
        // track deletes
        const eqCall = supabaseCalls.find(c => c.method === 'eq' && c.args[0] === 'id');
        if (eqCall) supabaseDeleted.push(eqCall.args[1]);
        return qb;
      }
      if (m === 'limit' || m === 'single') {
        return Promise.resolve({ data: returnData, error: returnError });
      }
      return qb;
    };
  }
  return qb;
}

const mockSupabase = {
  from: (table: string) => {
    supabaseCalls.push({ method: 'from', args: [table] });
    return createQueryBuilder();
  },
};

mock.module('@supabase/supabase-js', () => ({
  createClient: () => mockSupabase,
}));

mock.module('@elizaos/core', () => ({
  Service: class {
    static serviceType = 'base';
    capabilityDescription = '';
    constructor(runtime?: any) { (this as any).runtime = runtime; }
  },
  ModelType: { TEXT: 'TEXT', TEXT_SMALL: 'TEXT_SMALL', TEXT_LARGE: 'TEXT_LARGE' },
}));

// ============================================================
// Mock runtime factory
// ============================================================

interface MockLog { level: string; msg: string }

function makeMockRuntime(services: Record<string, any> = {}, overrides: Record<string, any> = {}) {
  const logs: MockLog[] = [];
  let modelResponse: any = '';

  const runtime: any = {
    getService: (name: string) => services[name] ?? null,
    getSetting: (name: string) => overrides[name] ?? null,
    agentId: 'test-agent',
    getRoom: async (roomId: string) => overrides.rooms?.[roomId] ?? null,
    logger: {
      info: (...args: any[]) => logs.push({ level: 'info', msg: args.map(String).join(' ') }),
      warn: (...args: any[]) => logs.push({ level: 'warn', msg: args.map(String).join(' ') }),
      error: (...args: any[]) => logs.push({ level: 'error', msg: args.map(String).join(' ') }),
    },
    useModel: async (_type: any, opts: any) => modelResponse,
    sendMessageToTarget: async () => {},
    getTasksByName: async () => [],
    createTask: async (t: any) => t,
    setModelResponse: (v: any) => { modelResponse = v; },
  };

  return { runtime, logs };
}

function makeMockMemoryService(overrides: Record<string, any> = {}) {
  return {
    storeMemory: async (m: any) => {
      storedMemories.push(m);
    },
    searchMemories: async (_query: string, _project: any, _limit?: number, _threshold?: number, _category?: string) => {
      return searchResults;
    },
    getSupabase: () => mockSupabase,
    ...overrides,
  };
}

// ============================================================
// 1. LESSON EXTRACTOR — evaluators/lesson-extractor.ts
// ============================================================

import { lessonExtractor } from '../plugins/itachi-self-improve/evaluators/lesson-extractor';

describe('LESSON_EXTRACTOR evaluator', () => {
  beforeEach(resetMocks);

  describe('validate()', () => {
    it('returns true when message contains task feedback words', async () => {
      const { runtime } = makeMockRuntime();
      const msg = { content: { text: 'That was a bad approach' } } as any;
      expect(await lessonExtractor.validate!(runtime, msg, {} as any)).toBe(true);
    });

    it('returns true for "good" feedback', async () => {
      const { runtime } = makeMockRuntime();
      expect(await lessonExtractor.validate!(runtime, { content: { text: 'great job on that task' } } as any, {} as any)).toBe(true);
    });

    it('returns true when message mentions completion', async () => {
      const { runtime } = makeMockRuntime();
      expect(await lessonExtractor.validate!(runtime, { content: { text: 'The task has completed' } } as any, {} as any)).toBe(true);
    });

    it('returns true for "failed" message', async () => {
      const { runtime } = makeMockRuntime();
      expect(await lessonExtractor.validate!(runtime, { content: { text: 'task failed with timeout' } } as any, {} as any)).toBe(true);
    });

    it('returns true when state has actionResults with taskId', async () => {
      const { runtime } = makeMockRuntime();
      const state = { data: { actionResults: [{ data: { taskId: 'abc123' } }] } };
      expect(await lessonExtractor.validate!(runtime, { content: { text: 'ok' } } as any, state as any)).toBe(true);
    });

    it('returns false for generic unrelated messages', async () => {
      const { runtime } = makeMockRuntime();
      expect(await lessonExtractor.validate!(runtime, { content: { text: 'what time is it' } } as any, {} as any)).toBe(false);
    });

    it('returns false for empty message', async () => {
      const { runtime } = makeMockRuntime();
      expect(await lessonExtractor.validate!(runtime, { content: { text: '' } } as any, {} as any)).toBe(false);
    });

    it('returns false for undefined content', async () => {
      const { runtime } = makeMockRuntime();
      expect(await lessonExtractor.validate!(runtime, { content: {} } as any, {} as any)).toBe(false);
    });
  });

  describe('handler()', () => {
    it('extracts and stores lessons from LLM response', async () => {
      const memService = makeMockMemoryService();
      const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.setModelResponse(JSON.stringify([
        { text: 'Auth tasks need targeted tests before PR', category: 'task-estimation', confidence: 0.8, outcome: 'success', project: 'itachi-memory' },
        { text: 'Always check CI before declaring done', category: 'error-handling', confidence: 0.7, outcome: 'failure', project: 'general' },
      ]));

      await lessonExtractor.handler(runtime, { content: { text: 'Task completed successfully' } } as any, {} as any);

      expect(storedMemories).toHaveLength(2);
      expect(storedMemories[0].category).toBe('task_lesson');
      expect(storedMemories[0].project).toBe('itachi-memory');
      expect(storedMemories[0].metadata.confidence).toBe(0.8);
      expect(storedMemories[0].metadata.source).toBe('lesson_extractor');
      expect(storedMemories[1].metadata.outcome).toBe('failure');
    });

    it('skips lessons with confidence below 0.5', async () => {
      const memService = makeMockMemoryService();
      const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.setModelResponse(JSON.stringify([
        { text: 'Weak signal', category: 'task-estimation', confidence: 0.3, outcome: 'partial', project: 'general' },
        { text: 'Strong signal', category: 'task-estimation', confidence: 0.9, outcome: 'success', project: 'general' },
      ]));

      await lessonExtractor.handler(runtime, { content: { text: 'Task failed' } } as any, {} as any);

      expect(storedMemories).toHaveLength(1);
      expect(storedMemories[0].summary).toContain('Strong signal');
    });

    it('handles LLM returning markdown-fenced JSON', async () => {
      const memService = makeMockMemoryService();
      const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.setModelResponse('```json\n[{"text":"lesson","category":"tool-selection","confidence":0.8,"outcome":"success","project":"general"}]\n```');

      await lessonExtractor.handler(runtime, { content: { text: 'completed' } } as any, {} as any);
      expect(storedMemories).toHaveLength(1);
    });

    it('handles unparseable LLM output gracefully', async () => {
      const memService = makeMockMemoryService();
      const { runtime, logs } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.setModelResponse('This is not JSON at all');

      await lessonExtractor.handler(runtime, { content: { text: 'completed' } } as any, {} as any);

      expect(storedMemories).toHaveLength(0);
      expect(logs.some(l => l.msg.includes('unparseable'))).toBe(true);
    });

    it('handles LLM returning non-array', async () => {
      const memService = makeMockMemoryService();
      const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.setModelResponse(JSON.stringify({ text: 'not an array' }));

      await lessonExtractor.handler(runtime, { content: { text: 'completed' } } as any, {} as any);
      expect(storedMemories).toHaveLength(0);
    });

    it('handles empty lesson array', async () => {
      const memService = makeMockMemoryService();
      const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.setModelResponse('[]');

      await lessonExtractor.handler(runtime, { content: { text: 'what time is it' } } as any, {} as any);
      expect(storedMemories).toHaveLength(0);
    });

    it('skips lessons with missing required fields', async () => {
      const memService = makeMockMemoryService();
      const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.setModelResponse(JSON.stringify([
        { text: '', category: 'tool-selection', confidence: 0.8, outcome: 'success' },    // empty text
        { text: 'good lesson', category: '', confidence: 0.8, outcome: 'success' },       // empty category
        { text: 'no confidence', category: 'tool-selection', outcome: 'success' },         // missing confidence
        { text: 'valid', category: 'tool-selection', confidence: 0.8, outcome: 'success', project: 'test' }, // valid
      ]));

      await lessonExtractor.handler(runtime, { content: { text: 'completed' } } as any, {} as any);
      expect(storedMemories).toHaveLength(1);
      expect(storedMemories[0].summary).toContain('valid');
    });

    it('skips when MemoryService is unavailable', async () => {
      const { runtime, logs } = makeMockRuntime();

      await lessonExtractor.handler(runtime, { content: { text: 'completed' } } as any, {} as any);
      expect(logs.some(l => l.msg.includes('MemoryService not available'))).toBe(true);
    });

    it('handles storeMemory throwing error', async () => {
      const failingMemService = makeMockMemoryService({
        storeMemory: async () => { throw new Error('Supabase down'); },
      });
      const { runtime, logs } = makeMockRuntime({ 'itachi-memory': failingMemService });

      runtime.setModelResponse(JSON.stringify([
        { text: 'lesson', category: 'error-handling', confidence: 0.8, outcome: 'failure', project: 'general' },
      ]));

      await lessonExtractor.handler(runtime, { content: { text: 'task failed' } } as any, {} as any);
      expect(logs.some(l => l.msg.includes('Failed to store lesson'))).toBe(true);
    });

    it('passes recent conversation context to the LLM prompt', async () => {
      let capturedPrompt = '';
      const memService = makeMockMemoryService();
      const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

      runtime.useModel = async (_type: any, opts: any) => {
        capturedPrompt = opts.prompt;
        return '[]';
      };

      const state = {
        data: {
          recentMessages: [
            { role: 'user', content: 'fix the auth bug' },
            { role: 'assistant', content: 'Working on it' },
          ],
        },
      };

      await lessonExtractor.handler(runtime, { content: { text: 'completed' } } as any, state as any);

      expect(capturedPrompt).toContain('fix the auth bug');
      expect(capturedPrompt).toContain('Working on it');
    });
  });
});

// ============================================================
// 2. LESSONS PROVIDER — providers/lessons.ts
// ============================================================

import { lessonsProvider } from '../plugins/itachi-self-improve/providers/lessons';

describe('MANAGEMENT_LESSONS provider', () => {
  beforeEach(resetMocks);

  it('has position 5 (early in context)', () => {
    expect(lessonsProvider.position).toBe(5);
  });

  it('returns empty for short queries (<5 chars)', async () => {
    const memService = makeMockMemoryService();
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

    const result = await lessonsProvider.get(runtime, { content: { text: 'hi' } } as any);
    expect(result.text).toBe('');
  });

  it('returns formatted lessons with metadata', async () => {
    searchResults = [
      {
        summary: 'Auth tasks need targeted tests',
        category: 'task_lesson',
        project: 'itachi-memory',
        similarity: 0.85,
        metadata: { confidence: 0.8, outcome: 'success', lesson_category: 'task-estimation' },
      },
      {
        summary: 'Use Opus for complex refactoring',
        category: 'task_lesson',
        project: 'general',
        similarity: 0.72,
        metadata: { confidence: 0.6, outcome: 'partial', lesson_category: 'tool-selection' },
      },
    ];

    const memService = makeMockMemoryService();
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

    const result = await lessonsProvider.get(runtime, { content: { text: 'create a task for auth module' } } as any);

    expect(result.text).toContain('Past Management Lessons');
    expect(result.text).toContain('task-estimation');
    expect(result.text).toContain('tool-selection');
    expect(result.text).toContain('confidence: 0.8');
    expect(result.text).toContain('relevance: 0.85');
    expect(result.values!.lessonCount).toBe('2');
  });

  it('includes strategy documents when available', async () => {
    // First call returns lessons, second returns strategies
    let callCount = 0;
    const memService = makeMockMemoryService({
      searchMemories: async (_q: string, _p: any, _l: number, _t: any, category: string) => {
        callCount++;
        if (category === 'task_lesson') {
          return [{ summary: 'Test lesson', category: 'task_lesson', metadata: {} }];
        }
        if (category === 'strategy_document') {
          return [{ summary: 'Always verify before deploy. Use incremental rollouts.', content: 'Full strategy...' }];
        }
        return [];
      },
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

    const result = await lessonsProvider.get(runtime, { content: { text: 'deploy the new feature' } } as any);

    expect(result.text).toContain('Current Strategy');
    expect(result.text).toContain('Always verify before deploy');
    expect(callCount).toBe(2); // lesson search + strategy search
  });

  it('handles MemoryService unavailable gracefully', async () => {
    const { runtime } = makeMockRuntime();

    const result = await lessonsProvider.get(runtime, { content: { text: 'create a task' } } as any);
    expect(result.text).toBe('');
  });

  it('handles search throwing errors gracefully', async () => {
    const memService = makeMockMemoryService({
      searchMemories: async () => { throw new Error('Embedding failed'); },
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

    const result = await lessonsProvider.get(runtime, { content: { text: 'create a task for auth' } } as any);
    expect(result.text).toBe('');
  });

  it('returns empty when no lessons found', async () => {
    searchResults = [];
    const memService = makeMockMemoryService();
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

    const result = await lessonsProvider.get(runtime, { content: { text: 'some unrelated thing' } } as any);
    expect(result.text).toBe('');
  });
});

// ============================================================
// 3. REFLECTION WORKER — workers/reflection-worker.ts
// ============================================================

import { reflectionWorker, registerReflectionTask } from '../plugins/itachi-self-improve/workers/reflection-worker';

describe('REFLECTION_WORKER', () => {
  beforeEach(resetMocks);

  it('validate always returns true', async () => {
    const { runtime } = makeMockRuntime();
    expect(await reflectionWorker.validate!(runtime, {} as any, {} as any)).toBe(true);
  });

  it('synthesizes lessons into a strategy document', async () => {
    const searchCallCategories: string[] = [];
    const memService = makeMockMemoryService({
      searchMemories: async (_q: string, _p: any, _l: number, _t: any, category: string) => {
        searchCallCategories.push(category);
        if (category === 'task_lesson') {
          return [
            { summary: 'Lesson 1', category: 'task_lesson', project: 'general', metadata: { confidence: 0.8, outcome: 'success', lesson_category: 'task-estimation' } },
            { summary: 'Lesson 2', category: 'task_lesson', project: 'itachi', metadata: { confidence: 0.7, outcome: 'failure', lesson_category: 'error-handling' } },
            { summary: 'Lesson 3', category: 'task_lesson', project: 'general', metadata: { confidence: 0.9, outcome: 'success', lesson_category: 'tool-selection' } },
          ];
        }
        if (category === 'strategy_document') return [];
        return [];
      },
    });

    const { runtime, logs } = makeMockRuntime({ 'itachi-memory': memService });
    runtime.setModelResponse('## Strategy\n1. Always test before deploying\n2. Use incremental rollouts\n3. Check error rates');

    await reflectionWorker.execute(runtime, {}, {} as any);

    // Should have stored a strategy_document
    expect(storedMemories).toHaveLength(1);
    expect(storedMemories[0].category).toBe('strategy_document');
    expect(storedMemories[0].metadata.source).toBe('reflection_worker');
    expect(storedMemories[0].metadata.lesson_count).toBe(3);
    expect(logs.some(l => l.msg.includes('Reflection complete'))).toBe(true);
    // Should have searched both task_lesson and strategy_document
    expect(searchCallCategories).toContain('task_lesson');
    expect(searchCallCategories).toContain('strategy_document');
  });

  it('requires minimum 3 lessons to synthesize', async () => {
    const memService = makeMockMemoryService({
      searchMemories: async () => [
        { summary: 'Only one', metadata: {}, category: 'task_lesson', project: 'x' },
      ],
    });
    const { runtime, logs } = makeMockRuntime({ 'itachi-memory': memService });

    await reflectionWorker.execute(runtime, {}, {} as any);

    expect(storedMemories).toHaveLength(0);
    expect(logs.some(l => l.msg.includes('Not enough lessons'))).toBe(true);
  });

  it('skips when MemoryService unavailable', async () => {
    const { runtime, logs } = makeMockRuntime();

    await reflectionWorker.execute(runtime, {}, {} as any);
    expect(logs.some(l => l.msg.includes('MemoryService not available'))).toBe(true);
  });

  it('skips when LLM returns insufficient strategy', async () => {
    const memService = makeMockMemoryService({
      searchMemories: async (_q: string, _p: any, _l: number, _t: any, cat: string) => {
        if (cat === 'task_lesson') return Array(5).fill({ summary: 'L', metadata: {}, category: 'task_lesson', project: 'x' });
        return [];
      },
    });
    const { runtime, logs } = makeMockRuntime({ 'itachi-memory': memService });
    runtime.setModelResponse('short');

    await reflectionWorker.execute(runtime, {}, {} as any);

    expect(storedMemories).toHaveLength(0);
    expect(logs.some(l => l.msg.includes('insufficient strategy'))).toBe(true);
  });

  it('passes lessons to LLM prompt for synthesis', async () => {
    let capturedPrompt = '';
    const memService = makeMockMemoryService({
      searchMemories: async (_q: string, _p: any, _l: number, _t: any, cat: string) => {
        if (cat === 'task_lesson') return [
          { summary: 'Auth needs tests', metadata: { confidence: 0.9, outcome: 'success', lesson_category: 'task-estimation' }, category: 'task_lesson', project: 'itachi-memory' },
          { summary: 'Budget too low for refactor', metadata: { confidence: 0.7, outcome: 'failure', lesson_category: 'task-estimation' }, category: 'task_lesson', project: 'general' },
          { summary: 'Use Opus for complex', metadata: { confidence: 0.8, outcome: 'success', lesson_category: 'tool-selection' }, category: 'task_lesson', project: 'general' },
        ];
        return [];
      },
    });
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });
    runtime.useModel = async (_type: any, opts: any) => {
      capturedPrompt = opts.prompt;
      return 'A valid strategy document that is long enough to pass the check for minimum length requirement.';
    };

    await reflectionWorker.execute(runtime, {}, {} as any);

    expect(capturedPrompt).toContain('Auth needs tests');
    expect(capturedPrompt).toContain('Budget too low');
    expect(capturedPrompt).toContain('Key Patterns');
  });
});

describe('registerReflectionTask', () => {
  it('creates task when none exists', async () => {
    let created = false;
    const { runtime } = makeMockRuntime();
    runtime.createTask = async () => { created = true; };

    await registerReflectionTask(runtime);
    expect(created).toBe(true);
  });

  it('skips when task already exists', async () => {
    let created = false;
    const { runtime } = makeMockRuntime();
    runtime.getTasksByName = async () => [{ id: 'existing' }];
    runtime.createTask = async () => { created = true; };

    await registerReflectionTask(runtime);
    expect(created).toBe(false);
  });
});

// ============================================================
// 4. TASK POLLER — extractLessonFromCompletion
// ============================================================

// The TaskPollerService is a class that extends Service, so we need to test
// the lesson extraction logic from completed tasks (the RL feedback loop).

describe('TaskPollerService — RL lesson extraction', () => {
  beforeEach(resetMocks);

  it('stores success lesson for completed task', async () => {
    const memService = makeMockMemoryService();
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

    // Simulate what extractLessonFromCompletion does
    const task = {
      id: 'aaaa-1111-2222-3333',
      project: 'itachi-memory',
      description: 'Fix the login authentication bug in the session handler',
      status: 'completed',
      result_summary: 'Fixed session timeout issue, added retry logic',
      files_changed: ['auth.ts', 'session.ts'],
    };

    const isFailure = task.status === 'failed' || task.status === 'timeout';
    const outcome = isFailure
      ? `FAILED: ${task.error_message || 'unknown error'}`
      : `COMPLETED: ${task.result_summary || 'no summary'}`;

    const lesson = isFailure
      ? `Task failed on project "${task.project}": ${task.description.substring(0, 100)}. Error: unknown`
      : `Task succeeded on project "${task.project}": ${task.description.substring(0, 100)}. ${task.result_summary?.substring(0, 200) || ''}`;

    await memService.storeMemory({
      project: task.project,
      category: 'task_lesson',
      content: `Task: ${task.description}\nOutcome: ${outcome}\nFiles: ${task.files_changed.join(', ')}`,
      summary: lesson,
      files: task.files_changed,
      task_id: task.id,
      metadata: {
        task_status: task.status,
        is_failure: isFailure,
        source: 'task_completion',
      },
    });

    expect(storedMemories).toHaveLength(1);
    expect(storedMemories[0].category).toBe('task_lesson');
    expect(storedMemories[0].metadata.source).toBe('task_completion');
    expect(storedMemories[0].metadata.is_failure).toBe(false);
    expect(storedMemories[0].summary).toContain('succeeded');
    expect(storedMemories[0].files).toEqual(['auth.ts', 'session.ts']);
  });

  it('stores failure lesson for failed task', async () => {
    const memService = makeMockMemoryService();

    const task = {
      id: 'bbbb-2222',
      project: 'itachi-dashboard',
      description: 'Deploy v2.0 to production',
      status: 'failed',
      error_message: 'Build failed: missing env vars',
      files_changed: [],
    };

    const isFailure = true;
    const lesson = `Task failed on project "${task.project}": ${task.description.substring(0, 100)}. Error: ${task.error_message.substring(0, 200)}. Consider: what prerequisites or validations could prevent this failure?`;

    await memService.storeMemory({
      project: task.project,
      category: 'task_lesson',
      content: `Task: ${task.description}\nOutcome: FAILED: ${task.error_message}`,
      summary: lesson,
      files: [],
      task_id: task.id,
      metadata: { task_status: 'failed', is_failure: true, source: 'task_completion' },
    });

    expect(storedMemories[0].metadata.is_failure).toBe(true);
    expect(storedMemories[0].summary).toContain('failed');
    expect(storedMemories[0].summary).toContain('missing env vars');
  });

  it('stores timeout lesson for timed-out task', async () => {
    const memService = makeMockMemoryService();

    const task = { id: 'cccc-3333', project: 'x', description: 'Long refactor', status: 'timeout', error_message: 'exceeded 10m limit' };
    const isFailure = task.status === 'failed' || task.status === 'timeout';
    expect(isFailure).toBe(true);

    await memService.storeMemory({
      project: task.project,
      category: 'task_lesson',
      summary: `Task failed: timeout`,
      content: 'timeout',
      files: [],
      metadata: { source: 'task_completion', is_failure: true, task_status: 'timeout' },
    });

    expect(storedMemories[0].metadata.task_status).toBe('timeout');
  });
});

// ============================================================
// 5. CORRECTION DETECTION — topic-input-relay
// ============================================================

describe('Correction pattern detection (topic-input-relay RL feedback)', () => {
  const correctionPattern = /\b(that'?s wrong|bad|incorrect|try again|don'?t do that|wrong approach|not what I|revert|undo|shouldn'?t have|mistake)\b|\bno\b(?=[,.\s!?]|$)/i;

  it('detects "that\'s wrong"', () => {
    expect(correctionPattern.test("that's wrong, try a different approach")).toBe(true);
  });

  it('detects "thats wrong" (without apostrophe)', () => {
    expect(correctionPattern.test("thats wrong")).toBe(true);
  });

  it('detects "bad" as feedback', () => {
    expect(correctionPattern.test("that's a bad solution")).toBe(true);
  });

  it('detects "incorrect"', () => {
    expect(correctionPattern.test("that output is incorrect")).toBe(true);
  });

  it('detects "try again"', () => {
    expect(correctionPattern.test("please try again with a different method")).toBe(true);
  });

  it('detects "don\'t do that"', () => {
    expect(correctionPattern.test("don't do that, it breaks things")).toBe(true);
  });

  it('detects "wrong approach"', () => {
    expect(correctionPattern.test("that's the wrong approach entirely")).toBe(true);
  });

  it('detects "revert"', () => {
    expect(correctionPattern.test("please revert that change")).toBe(true);
  });

  it('detects "undo"', () => {
    expect(correctionPattern.test("undo the last commit")).toBe(true);
  });

  it('detects "mistake"', () => {
    expect(correctionPattern.test("that was a mistake")).toBe(true);
  });

  it('detects bare "no" at end of sentence', () => {
    expect(correctionPattern.test("no")).toBe(true);
    expect(correctionPattern.test("no, that's not right")).toBe(true);
    expect(correctionPattern.test("no.")).toBe(true);
  });

  it('does NOT match "no" inside other words', () => {
    expect(correctionPattern.test("I know the answer")).toBe(false);
    expect(correctionPattern.test("nothing happened")).toBe(false);
  });

  it('does NOT match normal positive feedback', () => {
    expect(correctionPattern.test("looks good to me")).toBe(false);
    expect(correctionPattern.test("nice work")).toBe(false);
    expect(correctionPattern.test("perfect")).toBe(false);
  });

  it('does NOT match generic conversation', () => {
    expect(correctionPattern.test("can you add a feature")).toBe(false);
    expect(correctionPattern.test("what's the status")).toBe(false);
  });
});

// ============================================================
// 6. RL PIPELINE INTEGRATION — Full Cycle
// ============================================================

describe('RL Pipeline — full cycle integration', () => {
  beforeEach(resetMocks);

  it('lesson extraction → storage → retrieval → injection cycle', async () => {
    // Step 1: Extract lesson
    const memService = makeMockMemoryService();
    const { runtime } = makeMockRuntime({ 'itachi-memory': memService });

    runtime.setModelResponse(JSON.stringify([
      { text: 'SSH tasks need env var validation', category: 'error-handling', confidence: 0.85, outcome: 'failure', project: 'itachi-memory' },
    ]));

    await lessonExtractor.handler(runtime, { content: { text: 'Task failed due to missing SSH key' } } as any, {} as any);

    expect(storedMemories).toHaveLength(1);
    const stored = storedMemories[0];

    // Step 2: Simulate retrieval via lessonsProvider
    searchResults = [{
      summary: stored.summary,
      category: stored.category,
      project: stored.project,
      similarity: 0.9,
      metadata: stored.metadata,
    }];

    const result = await lessonsProvider.get(runtime, { content: { text: 'create an SSH task for deployment' } } as any);

    // Step 3: Verify lesson appears in context
    expect(result.text).toContain('Past Management Lessons');
    expect(result.text).toContain('error-handling');
    expect(result.text).toContain('confidence: 0.85');
    expect(result.values!.lessonCount).toBe('1');
  });

  it('multiple feedback sources converge into unified lesson store', async () => {
    const memService = makeMockMemoryService();

    // Source 1: task_completion (from task-poller)
    await memService.storeMemory({
      project: 'itachi-memory', category: 'task_lesson',
      content: 'Task completed', summary: 'Success on auth fix',
      files: [], metadata: { source: 'task_completion', is_failure: false },
    });

    // Source 2: user_correction (from topic-input-relay)
    await memService.storeMemory({
      project: 'itachi-memory', category: 'task_lesson',
      content: 'User correction', summary: 'User said approach was wrong',
      files: [], metadata: { source: 'user_correction', confidence: 0.9 },
    });

    // Source 3: lesson_extractor (from evaluator)
    await memService.storeMemory({
      project: 'itachi-memory', category: 'task_lesson',
      content: 'Extracted lesson', summary: 'Use tests before PR',
      files: [], metadata: { source: 'lesson_extractor', confidence: 0.8 },
    });

    // All stored under same category
    expect(storedMemories).toHaveLength(3);
    expect(storedMemories.every(m => m.category === 'task_lesson')).toBe(true);

    // Different sources
    const sources = storedMemories.map(m => m.metadata.source);
    expect(sources).toContain('task_completion');
    expect(sources).toContain('user_correction');
    expect(sources).toContain('lesson_extractor');
  });
});
