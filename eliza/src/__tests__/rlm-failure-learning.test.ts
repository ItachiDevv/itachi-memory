import { describe, it, expect } from 'bun:test';

// ============================================================
// RLM Failure → Learning → Improvement Tests
//
// Proves that the RLM pipeline correctly:
// 1. Records failures with proper metadata
// 2. Demotes failure lessons in future retrievals
// 3. Reinforces context lessons on success/failure
// 4. Full multi-task learning chains where Task B learns from Task A's failure
// 5. Cross-project learning transfer
// 6. Confidence convergence over repeated reinforcements
// 7. The task-poller reinforcement loop (success boosts, failure demotes context)
// ============================================================

interface MockMemory {
  id: string;
  project: string;
  category: string;
  content: string;
  summary: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

// ── Mirrored helpers from production code ──────────────────

const CATEGORY_BOOST: Record<string, number> = {
  project_rule: 1.25,
  task_lesson: 1.20,
  error_recovery: 1.15,
  bug_fix: 1.10,
  conversation: 1.05,
  code_change: 0.85,
  documentation: 0.90,
  session: 0.80,
};

function applyOutcomeReranking(results: MockMemory[]): MockMemory[] {
  return results
    .map((m) => {
      const outcomeVal = m.metadata?.outcome;
      let sim = m.similarity ?? 0.5;
      if (outcomeVal === 'success') sim = Math.min(sim * 1.1, 1.0);
      else if (outcomeVal === 'failure') sim = sim * 0.7;
      const catBoost = CATEGORY_BOOST[m.category] ?? 1.0;
      sim = Math.min(sim * catBoost, 1.0);
      return { ...m, similarity: sim };
    })
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
}

// ── In-memory store with full reinforcement logic ──────────

function createMemoryStore() {
  const memories: MockMemory[] = [];
  let idCounter = 0;

  return {
    store(mem: Omit<MockMemory, 'id'>): MockMemory {
      const stored = { ...mem, id: `mem-${++idCounter}` } as MockMemory;
      memories.push(stored);
      return stored;
    },
    search(query: string, project?: string, limit = 5, category?: string): MockMemory[] {
      const queryLower = query.toLowerCase();
      return memories
        .filter((m) => (!project || m.project === project) && (!category || m.category === category))
        .map((m) => ({
          ...m,
          // Simulate semantic similarity via keyword overlap
          similarity: computeSimilarity(m.content.toLowerCase(), queryLower),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    },
    getAll: () => [...memories],
    getById(id: string): MockMemory | undefined {
      return memories.find((m) => m.id === id);
    },
    reinforce(id: string, update: { confidence?: number; last_outcome?: string }): void {
      const idx = memories.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const existing = memories[idx];
        const currentConf = typeof existing.metadata.confidence === 'number' ? existing.metadata.confidence : 0.5;
        memories[idx] = {
          ...existing,
          metadata: {
            ...existing.metadata,
            ...update,
            confidence: update.confidence ?? currentConf,
            times_reinforced: (Number(existing.metadata.times_reinforced) || 1) + 1,
            last_reinforced: new Date().toISOString(),
          },
        };
      }
    },
  };
}

function computeSimilarity(content: string, query: string): number {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0.3;
  const matches = words.filter((w) => content.includes(w)).length;
  return 0.3 + 0.6 * (matches / words.length);
}

// ── Simulates task-poller extractLessonFromCompletion ───────

function simulateTaskCompletion(
  store: ReturnType<typeof createMemoryStore>,
  task: {
    id: string;
    description: string;
    project: string;
    status: 'completed' | 'failed' | 'timeout';
    result_summary?: string;
    error_message?: string;
    files_changed?: string[];
  },
): MockMemory {
  const isFailure = task.status === 'failed' || task.status === 'timeout';
  const outcome = isFailure
    ? `FAILED: ${task.error_message || 'unknown error'}`
    : `COMPLETED: ${task.result_summary || 'no summary'}`;

  const lesson = isFailure
    ? `Task failed on project "${task.project}": ${task.description.substring(0, 100)}. Error: ${task.error_message?.substring(0, 200) || 'unknown'}.`
    : `Task succeeded on project "${task.project}": ${task.description.substring(0, 100)}. ${task.result_summary?.substring(0, 200) || ''}`;

  const stored = store.store({
    project: task.project,
    category: 'task_lesson',
    content: `Task: ${task.description}\nOutcome: ${outcome}\nFiles: ${(task.files_changed || []).join(', ') || 'none'}`,
    summary: lesson,
    similarity: 0,
    metadata: {
      task_status: task.status,
      is_failure: isFailure,
      outcome: isFailure ? 'failure' : 'success',
      source: 'task_completion',
    },
  });

  // Reinforce context lessons (mirroring task-poller lines 126-150)
  const contextLessons = store.search(task.description.substring(0, 200), task.project, 5);
  for (const cl of contextLessons) {
    if (cl.id === stored.id) continue;
    const confNum = typeof cl.metadata.confidence === 'number' ? cl.metadata.confidence : 0.5;
    if (isFailure) {
      store.reinforce(cl.id, {
        confidence: Math.max(confNum * 0.85, 0.1),
        last_outcome: 'failure',
      });
    } else {
      store.reinforce(cl.id, {
        confidence: Math.min(confNum + 0.05, 0.99),
        last_outcome: 'success',
      });
    }
  }

  return stored;
}

// ============================================================
// 1. Failure recording
// ============================================================

describe('RLM failure learning — failure recording', () => {
  it('should store failed task with outcome: failure', () => {
    const store = createMemoryStore();
    const lesson = simulateTaskCompletion(store, {
      id: 'task-1',
      description: 'Run bun test on nonexistent file',
      project: 'itachi-memory',
      status: 'failed',
      error_message: 'Test file not found',
    });

    expect(lesson.metadata.outcome).toBe('failure');
    expect(lesson.metadata.is_failure).toBe(true);
    expect(lesson.metadata.task_status).toBe('failed');
    expect(lesson.content).toContain('FAILED');
    expect(lesson.summary).toContain('Task failed');
  });

  it('should store timeout task with outcome: failure', () => {
    const store = createMemoryStore();
    const lesson = simulateTaskCompletion(store, {
      id: 'task-2',
      description: 'Deploy to production',
      project: 'my-app',
      status: 'timeout',
      error_message: 'Task timed out after 20 minutes',
    });

    expect(lesson.metadata.outcome).toBe('failure');
    expect(lesson.metadata.is_failure).toBe(true);
    expect(lesson.metadata.task_status).toBe('timeout');
  });

  it('should store successful task with outcome: success', () => {
    const store = createMemoryStore();
    const lesson = simulateTaskCompletion(store, {
      id: 'task-3',
      description: 'Run bun test src/__tests__/',
      project: 'itachi-memory',
      status: 'completed',
      result_summary: '1078 pass, 0 fail',
    });

    expect(lesson.metadata.outcome).toBe('success');
    expect(lesson.metadata.is_failure).toBe(false);
    expect(lesson.content).toContain('COMPLETED');
  });
});

// ============================================================
// 2. Failure demotion in retrieval
// ============================================================

describe('RLM failure learning — failure demotion in search results', () => {
  it('should rank failure lessons below success lessons with same base similarity', () => {
    const store = createMemoryStore();

    // Task A fails
    simulateTaskCompletion(store, {
      id: 'task-a',
      description: 'Run bun test on task-detection file',
      project: 'itachi-memory',
      status: 'failed',
      error_message: 'Cannot find test file',
    });

    // Task B succeeds (similar description)
    simulateTaskCompletion(store, {
      id: 'task-b',
      description: 'Run bun test on task-detection tests',
      project: 'itachi-memory',
      status: 'completed',
      result_summary: '21 pass',
    });

    // Search for related lessons
    const results = store.search('run bun test task-detection', 'itachi-memory', 5);
    const ranked = applyOutcomeReranking(results);

    // Success lesson should rank higher
    const successIdx = ranked.findIndex((r) => r.metadata.outcome === 'success');
    const failureIdx = ranked.findIndex((r) => r.metadata.outcome === 'failure');
    expect(successIdx).toBeLessThan(failureIdx);
    expect(ranked[successIdx].similarity).toBeGreaterThan(ranked[failureIdx].similarity);
  });

  it('should demote failure by 30% before category boost', () => {
    const failureLesson: MockMemory = {
      id: 'f1',
      project: 'p',
      category: 'task_lesson',
      content: '',
      summary: '',
      similarity: 0.9,
      metadata: { outcome: 'failure' },
    };

    const ranked = applyOutcomeReranking([failureLesson]);
    // 0.9 * 0.7 = 0.63, then * 1.20 (task_lesson) = 0.756
    expect(ranked[0].similarity).toBeCloseTo(0.756, 3);
  });

  it('should keep failure lessons accessible but lower-ranked', () => {
    const results: MockMemory[] = [
      // Failure: 0.95 * 0.7 * 1.20 = 0.798
      { id: '1', project: 'p', category: 'task_lesson', content: '', summary: 'Failed deploy', similarity: 0.95, metadata: { outcome: 'failure' } },
      // Success: 0.7 * 1.1 * 1.20 = 0.924
      { id: '2', project: 'p', category: 'task_lesson', content: '', summary: 'Successful deploy', similarity: 0.7, metadata: { outcome: 'success' } },
      // Neutral: 0.6 * 1.20 = 0.72
      { id: '3', project: 'p', category: 'task_lesson', content: '', summary: 'Neutral info', similarity: 0.6, metadata: {} },
    ];

    const ranked = applyOutcomeReranking(results);

    // All 3 should still be in results (failures aren't removed, just demoted)
    expect(ranked).toHaveLength(3);
    // Success should be first despite lower base similarity (0.924)
    expect(ranked[0].id).toBe('2');
    // Failure should rank below success despite higher base similarity
    // Failure (0.798) > Neutral (0.72), so failure is middle, neutral is last
    expect(ranked[1].id).toBe('1');
    expect(ranked[2].id).toBe('3');
  });
});

// ============================================================
// 3. Context reinforcement loop
// ============================================================

describe('RLM failure learning — context reinforcement', () => {
  it('should boost confidence of context lessons on success', () => {
    const store = createMemoryStore();

    // Pre-existing lesson
    const existing = store.store({
      project: 'itachi-memory',
      category: 'task_lesson',
      content: 'Task: Run tests before deploy\nOutcome: COMPLETED',
      summary: 'Run tests before deploy',
      similarity: 0,
      metadata: { confidence: 0.5, outcome: 'success' },
    });

    // New successful task (similar content, triggers reinforcement)
    simulateTaskCompletion(store, {
      id: 'task-new',
      description: 'Run tests before deploy on coolify',
      project: 'itachi-memory',
      status: 'completed',
      result_summary: 'All tests pass',
    });

    const updated = store.getById(existing.id)!;
    expect(updated.metadata.confidence).toBe(0.55); // 0.5 + 0.05
    expect(updated.metadata.last_outcome).toBe('success');
    expect(updated.metadata.times_reinforced).toBe(2);
  });

  it('should reduce confidence of context lessons on failure', () => {
    const store = createMemoryStore();

    // Pre-existing lesson with high confidence
    const existing = store.store({
      project: 'itachi-memory',
      category: 'task_lesson',
      content: 'Task: Deploy to production\nOutcome: COMPLETED',
      summary: 'Deploy works fine',
      similarity: 0,
      metadata: { confidence: 0.8, outcome: 'success' },
    });

    // New FAILED task (similar content, triggers negative reinforcement)
    simulateTaskCompletion(store, {
      id: 'task-fail',
      description: 'Deploy to production on coolify',
      project: 'itachi-memory',
      status: 'failed',
      error_message: 'Build failed: type error in main.ts',
    });

    const updated = store.getById(existing.id)!;
    expect(updated.metadata.confidence).toBe(0.68); // 0.8 * 0.85
    expect(updated.metadata.last_outcome).toBe('failure');
  });

  it('should not reinforce the lesson that was just stored', () => {
    const store = createMemoryStore();

    const lesson = simulateTaskCompletion(store, {
      id: 'task-solo',
      description: 'Unique task with no prior context',
      project: 'unique-project',
      status: 'completed',
      result_summary: 'Done',
    });

    // The newly stored lesson should NOT have been reinforced
    expect(lesson.metadata.times_reinforced).toBeUndefined();
  });
});

// ============================================================
// 4. Multi-task learning chain
// ============================================================

describe('RLM failure learning — multi-task chain', () => {
  it('should show Task B learning from Task A failure', () => {
    const store = createMemoryStore();

    // Task A: FAILS trying to run tests with wrong path
    simulateTaskCompletion(store, {
      id: 'task-a',
      description: 'Run bun test src/tests/ on itachi-memory',
      project: 'itachi-memory',
      status: 'failed',
      error_message: 'No tests found in src/tests/',
    });

    // Task B: SUCCEEDS with correct path
    simulateTaskCompletion(store, {
      id: 'task-b',
      description: 'Run bun test src/__tests__/ on itachi-memory',
      project: 'itachi-memory',
      status: 'completed',
      result_summary: '1078 pass, 0 fail',
    });

    // Search for "run tests" context
    const results = store.search('run bun test', 'itachi-memory', 5);
    const ranked = applyOutcomeReranking(results);

    // The successful lesson should rank first
    expect(ranked[0].metadata.outcome).toBe('success');
    expect(ranked[0].content).toContain('src/__tests__/');

    // The failure lesson should still be present but ranked lower
    const failureResult = ranked.find((r) => r.metadata.outcome === 'failure');
    expect(failureResult).toBeTruthy();
    expect(failureResult!.content).toContain('src/tests/');
    expect(failureResult!.similarity).toBeLessThan(ranked[0].similarity);
  });

  it('should build prompt for Task C that includes both success and failure context', () => {
    const store = createMemoryStore();

    // Task A fails
    simulateTaskCompletion(store, {
      id: 'task-a',
      description: 'Create file at src/tests/helper.ts',
      project: 'itachi-memory',
      status: 'failed',
      error_message: 'Directory src/tests/ does not exist',
    });

    // Task B succeeds
    simulateTaskCompletion(store, {
      id: 'task-b',
      description: 'Create file at src/__tests__/helper.test.ts',
      project: 'itachi-memory',
      status: 'completed',
      result_summary: 'File created and tests pass',
    });

    // Build prompt for Task C (similar to both)
    const contextMemories = store.search('create test helper file', 'itachi-memory', 5);
    const ranked = applyOutcomeReranking(contextMemories);

    const lines = [
      'You are working on project "itachi-memory".',
      '',
      'Create a new test helper utility',
      '',
      '--- Relevant context from memory ---',
    ];
    for (const mem of ranked) {
      lines.push(`- ${mem.summary}`);
    }
    const prompt = lines.join('\n');

    // Prompt should contain both lessons so Task C can learn from both
    expect(prompt).toContain('Task succeeded');
    expect(prompt).toContain('Task failed');
    // Success lesson should appear before failure (higher ranked)
    const successPos = prompt.indexOf('Task succeeded');
    const failurePos = prompt.indexOf('Task failed');
    expect(successPos).toBeLessThan(failurePos);
  });
});

// ============================================================
// 5. Cross-project learning
// ============================================================

describe('RLM failure learning — cross-project', () => {
  it('should find lessons from other projects when searching without project filter', () => {
    const store = createMemoryStore();

    // Lesson from project A
    store.store({
      project: 'project-a',
      category: 'task_lesson',
      content: 'Always run build before deploying to prevent type errors',
      summary: 'Run build before deploy',
      similarity: 0,
      metadata: { outcome: 'success', confidence: 0.8 },
    });

    // Search without project filter — should find cross-project lessons
    const results = store.search('run build before deploy', undefined, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].project).toBe('project-a');
  });

  it('should not mix project-specific lessons when project is specified', () => {
    const store = createMemoryStore();

    store.store({
      project: 'project-a',
      category: 'task_lesson',
      content: 'Deploy via SSH to production',
      summary: 'Deploy via SSH',
      similarity: 0,
      metadata: { outcome: 'success' },
    });

    store.store({
      project: 'project-b',
      category: 'task_lesson',
      content: 'Deploy via Coolify auto-deploy',
      summary: 'Deploy via Coolify',
      similarity: 0,
      metadata: { outcome: 'success' },
    });

    // Search with project filter
    const resultsA = store.search('deploy', 'project-a', 5);
    const resultsB = store.search('deploy', 'project-b', 5);

    expect(resultsA.every((r) => r.project === 'project-a')).toBe(true);
    expect(resultsB.every((r) => r.project === 'project-b')).toBe(true);
  });
});

// ============================================================
// 6. Confidence convergence
// ============================================================

describe('RLM failure learning — confidence convergence', () => {
  it('should converge confidence upward with repeated successes', () => {
    const store = createMemoryStore();

    const lesson = store.store({
      project: 'p',
      category: 'task_lesson',
      content: 'Reliable pattern for testing',
      summary: 'Reliable pattern',
      similarity: 0,
      metadata: { confidence: 0.5, outcome: 'success' },
    });

    // Simulate 10 successive successes
    for (let i = 0; i < 10; i++) {
      const current = store.getById(lesson.id)!;
      const conf = typeof current.metadata.confidence === 'number' ? current.metadata.confidence : 0.5;
      store.reinforce(lesson.id, {
        confidence: Math.min(conf + 0.05, 0.99),
        last_outcome: 'success',
      });
    }

    const final = store.getById(lesson.id)!;
    expect(final.metadata.confidence).toBe(0.99); // Capped at 0.99
    expect(final.metadata.times_reinforced).toBe(11); // 1 initial + 10 reinforcements
  });

  it('should converge confidence downward with repeated failures', () => {
    const store = createMemoryStore();

    const lesson = store.store({
      project: 'p',
      category: 'task_lesson',
      content: 'Unreliable pattern that keeps failing',
      summary: 'Unreliable pattern',
      similarity: 0,
      metadata: { confidence: 0.8, outcome: 'success' },
    });

    // Simulate 5 successive failures (0.85x each)
    for (let i = 0; i < 5; i++) {
      const current = store.getById(lesson.id)!;
      const conf = typeof current.metadata.confidence === 'number' ? current.metadata.confidence : 0.5;
      store.reinforce(lesson.id, {
        confidence: Math.max(conf * 0.85, 0.1),
        last_outcome: 'failure',
      });
    }

    const final = store.getById(lesson.id)!;
    // 0.8 * 0.85^5 = 0.8 * 0.4437 ≈ 0.355
    expect(final.metadata.confidence as number).toBeLessThan(0.4);
    expect(final.metadata.confidence as number).toBeGreaterThan(0.1); // Above floor
    expect(final.metadata.last_outcome).toBe('failure');
  });

  it('should floor confidence at 0.1 even with many failures', () => {
    const store = createMemoryStore();

    const lesson = store.store({
      project: 'p',
      category: 'task_lesson',
      content: 'Bad pattern',
      summary: 'Bad',
      similarity: 0,
      metadata: { confidence: 0.2, outcome: 'failure' },
    });

    // 20 failures — should hit floor
    for (let i = 0; i < 20; i++) {
      const current = store.getById(lesson.id)!;
      const conf = typeof current.metadata.confidence === 'number' ? current.metadata.confidence : 0.5;
      store.reinforce(lesson.id, {
        confidence: Math.max(conf * 0.85, 0.1),
        last_outcome: 'failure',
      });
    }

    const final = store.getById(lesson.id)!;
    expect(final.metadata.confidence).toBe(0.1); // Floored
  });

  it('should recover confidence after failure then success', () => {
    const store = createMemoryStore();

    const lesson = store.store({
      project: 'p',
      category: 'task_lesson',
      content: 'Pattern that failed then recovered',
      summary: 'Recovered',
      similarity: 0,
      metadata: { confidence: 0.6, outcome: 'success' },
    });

    // 3 failures: 0.6 * 0.85^3 ≈ 0.368
    for (let i = 0; i < 3; i++) {
      const current = store.getById(lesson.id)!;
      const conf = typeof current.metadata.confidence === 'number' ? current.metadata.confidence : 0.5;
      store.reinforce(lesson.id, {
        confidence: Math.max(conf * 0.85, 0.1),
        last_outcome: 'failure',
      });
    }

    const afterFailures = store.getById(lesson.id)!;
    const confAfterFail = afterFailures.metadata.confidence as number;
    expect(confAfterFail).toBeLessThan(0.4);

    // 5 successes: should recover
    for (let i = 0; i < 5; i++) {
      const current = store.getById(lesson.id)!;
      const conf = typeof current.metadata.confidence === 'number' ? current.metadata.confidence : 0.5;
      store.reinforce(lesson.id, {
        confidence: Math.min(conf + 0.05, 0.99),
        last_outcome: 'success',
      });
    }

    const afterRecovery = store.getById(lesson.id)!;
    expect(afterRecovery.metadata.confidence as number).toBeGreaterThan(confAfterFail);
    expect(afterRecovery.metadata.last_outcome).toBe('success');
  });
});

// ============================================================
// 7. Task-poller reinforcement loop integration
// ============================================================

describe('RLM failure learning — task-poller reinforcement loop', () => {
  it('should simulate complete task-poller flow: store lesson + reinforce context', () => {
    const store = createMemoryStore();

    // Pre-existing lessons in the store
    store.store({
      project: 'itachi-memory',
      category: 'task_lesson',
      content: 'Task: Deploy via git push\nOutcome: COMPLETED',
      summary: 'Git push deploy works',
      similarity: 0,
      metadata: { confidence: 0.5, outcome: 'success' },
    });

    store.store({
      project: 'itachi-memory',
      category: 'task_lesson',
      content: 'Task: Test bun build\nOutcome: COMPLETED',
      summary: 'Bun build succeeds',
      similarity: 0,
      metadata: { confidence: 0.6, outcome: 'success' },
    });

    // New task fails — triggers extractLessonFromCompletion
    const newLesson = simulateTaskCompletion(store, {
      id: 'task-new',
      description: 'Deploy via git push after bun build',
      project: 'itachi-memory',
      status: 'failed',
      error_message: 'Build failed: missing dependency',
    });

    // New lesson should be stored
    expect(newLesson.metadata.outcome).toBe('failure');

    // Context lessons should have reduced confidence
    const allLessons = store.getAll();
    const contextLessons = allLessons.filter((m) => m.id !== newLesson.id);

    for (const cl of contextLessons) {
      // Only those that matched the search should be reinforced
      if (cl.metadata.times_reinforced && Number(cl.metadata.times_reinforced) > 1) {
        expect(cl.metadata.last_outcome).toBe('failure');
        expect(cl.metadata.confidence as number).toBeLessThan(0.6);
      }
    }
  });

  it('should handle task with no matching context lessons gracefully', () => {
    const store = createMemoryStore();

    // Store a completely unrelated lesson
    store.store({
      project: 'other-project',
      category: 'task_lesson',
      content: 'Unrelated lesson about cooking',
      summary: 'Cook pasta',
      similarity: 0,
      metadata: { confidence: 0.5 },
    });

    // Task on different project — no context matches
    const lesson = simulateTaskCompletion(store, {
      id: 'task-isolated',
      description: 'Unique scientific computation',
      project: 'itachi-memory',
      status: 'completed',
      result_summary: 'Done',
    });

    // Should store lesson without crashing
    expect(lesson.metadata.outcome).toBe('success');

    // Unrelated lesson should NOT have been reinforced
    const unrelated = store.getAll().find((m) => m.summary === 'Cook pasta')!;
    expect(unrelated.metadata.times_reinforced).toBeUndefined();
  });
});

// ============================================================
// 8. Edge cases
// ============================================================

describe('RLM failure learning — edge cases', () => {
  it('should handle partial outcome (neither success nor failure)', () => {
    const result: MockMemory = {
      id: '1',
      project: 'p',
      category: 'task_lesson',
      content: '',
      summary: '',
      similarity: 0.8,
      metadata: { outcome: 'partial' },
    };

    const ranked = applyOutcomeReranking([result]);
    // Partial: no multiplier applied, only category boost
    // 0.8 * 1.20 = 0.96
    expect(ranked[0].similarity).toBeCloseTo(0.96, 3);
  });

  it('should handle missing metadata gracefully', () => {
    const result: MockMemory = {
      id: '1',
      project: 'p',
      category: 'task_lesson',
      content: '',
      summary: '',
      similarity: 0.8,
      metadata: {},
    };

    const ranked = applyOutcomeReranking([result]);
    expect(ranked[0].similarity).toBeCloseTo(0.96, 3); // Just category boost
  });

  it('should handle reinforcement of lesson with no prior confidence', () => {
    const store = createMemoryStore();
    const lesson = store.store({
      project: 'p',
      category: 'task_lesson',
      content: 'No confidence set',
      summary: 'No conf',
      similarity: 0,
      metadata: { outcome: 'success' }, // No confidence field
    });

    store.reinforce(lesson.id, {
      confidence: Math.min(0.5 + 0.05, 0.99), // Defaults to 0.5
      last_outcome: 'success',
    });

    const updated = store.getById(lesson.id)!;
    expect(updated.metadata.confidence).toBe(0.55);
  });

  it('should handle very low similarity inputs', () => {
    const results: MockMemory[] = [
      { id: '1', project: 'p', category: 'task_lesson', content: '', summary: '', similarity: 0.01, metadata: { outcome: 'failure' } },
      { id: '2', project: 'p', category: 'task_lesson', content: '', summary: '', similarity: 0.01, metadata: { outcome: 'success' } },
    ];

    const ranked = applyOutcomeReranking(results);
    // Even at low similarity, success should rank higher
    expect(ranked[0].id).toBe('2');
    // Failure: 0.01 * 0.7 * 1.2 = 0.0084
    // Success: 0.01 * 1.1 * 1.2 = 0.0132
    expect(ranked[0].similarity).toBeGreaterThan(ranked[1].similarity);
  });

  it('should handle large number of memories in search', () => {
    const store = createMemoryStore();

    // Store 50 lessons
    for (let i = 0; i < 50; i++) {
      store.store({
        project: 'big-project',
        category: 'task_lesson',
        content: `Task lesson ${i}: deploy service number ${i}`,
        summary: `Deploy service ${i}`,
        similarity: 0,
        metadata: { outcome: i % 3 === 0 ? 'failure' : 'success', confidence: 0.5 },
      });
    }

    // Search should respect limit
    const results = store.search('deploy service', 'big-project', 5);
    expect(results).toHaveLength(5);

    // Reranking should work on limited set
    const ranked = applyOutcomeReranking(results);
    expect(ranked).toHaveLength(5);
    // Should be sorted by adjusted similarity
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i].similarity).toBeGreaterThanOrEqual(ranked[i + 1].similarity);
    }
  });
});
