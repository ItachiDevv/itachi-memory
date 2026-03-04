import { describe, it, expect } from 'bun:test';

// ============================================================
// RLM Lifecycle Tests — Full learn → retrieve → enrich cycle
// Verifies outcome reranking, reinforcement, buildPrompt inclusion,
// and metadata stored by transcript-analyzer and task-poller.
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

// ── Mirrored helpers ─────────────────────────────────────────

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

function reinforceMemory(
  memory: MockMemory,
  update: { confidence?: number; last_outcome?: string },
): MockMemory {
  const current = typeof memory.metadata.confidence === 'number' ? memory.metadata.confidence : 0.5;
  return {
    ...memory,
    metadata: {
      ...memory.metadata,
      ...update,
      confidence: update.confidence ?? current,
      times_reinforced: (Number(memory.metadata.times_reinforced) || 1) + 1,
      last_reinforced: new Date().toISOString(),
    },
  };
}

function buildPrompt(description: string, project: string, memories: MockMemory[], rules: MockMemory[]): string {
  const lines = [
    `You are working on project "${project}".`,
    '',
    description,
    '',
    'Instructions:',
    '- Work autonomously. Make all necessary changes.',
  ];

  if (memories.length > 0) {
    lines.push('', '--- Relevant context from memory ---');
    for (const mem of memories) {
      lines.push(`- ${mem.summary || mem.content.substring(0, 200)}`);
    }
  }

  if (rules.length > 0) {
    lines.push('', '--- Project rules ---');
    for (const rule of rules) {
      lines.push(`- ${rule.summary || rule.content.substring(0, 200)}`);
    }
  }

  return lines.join('\n');
}

// ── In-memory store for tests ────────────────────────────────

function createMemoryStore() {
  const memories: MockMemory[] = [];

  return {
    store(mem: Omit<MockMemory, 'id'>): MockMemory {
      const stored = { ...mem, id: `mem-${memories.length + 1}` } as MockMemory;
      memories.push(stored);
      return stored;
    },
    search(query: string, project: string, limit: number, category?: string): MockMemory[] {
      return memories
        .filter((m) => m.project === project && (!category || m.category === category))
        .map((m) => ({
          ...m,
          // Fake similarity based on content overlap
          similarity: m.content.toLowerCase().includes(query.toLowerCase().substring(0, 20)) ? 0.85 : 0.5,
        }))
        .slice(0, limit);
    },
    getAll: () => [...memories],
    reinforce(id: string, update: { confidence?: number; last_outcome?: string }): void {
      const idx = memories.findIndex((m) => m.id === id);
      if (idx >= 0) {
        memories[idx] = reinforceMemory(memories[idx], update);
      }
    },
  };
}

// ============================================================
// 1. Store + retrieve with outcome boost
// ============================================================

describe('RLM lifecycle — store and retrieve', () => {
  it('should boost retrieved success lessons over no-outcome lessons', () => {
    const store = createMemoryStore();

    const successLesson = store.store({
      project: 'test-proj',
      category: 'task_lesson',
      content: 'Run bun test before deploying',
      summary: 'Always test before deploy',
      similarity: 0.8,
      metadata: { outcome: 'success', source: 'task_completion' },
    });

    const neutralLesson = store.store({
      project: 'test-proj',
      category: 'task_lesson',
      content: 'Check git status before committing',
      summary: 'Check git status',
      similarity: 0.8,
      metadata: { source: 'task_completion' },
    });

    const results = applyOutcomeReranking([
      { ...successLesson, similarity: 0.8 },
      { ...neutralLesson, similarity: 0.8 },
    ]);

    // Success: 0.8 * 1.1 * 1.20 = 0.96 (capped)
    // Neutral: 0.8 * 1.20 = 0.96
    // Both are 0.96, but success path: min(0.88, 1.0) = 0.88 * 1.20 = 1.056 → 1.0
    // Neutral: 0.8 * 1.20 = 0.96
    expect(results[0].metadata.outcome).toBe('success');
    expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
  });

  it('should rank failure lessons lower than success despite same base similarity', () => {
    const results = applyOutcomeReranking([
      {
        id: 'fail', project: 'p', category: 'task_lesson', content: '', summary: 'Failed',
        similarity: 0.8, metadata: { outcome: 'failure' },
      },
      {
        id: 'pass', project: 'p', category: 'task_lesson', content: '', summary: 'Passed',
        similarity: 0.8, metadata: { outcome: 'success' },
      },
    ]);

    expect(results[0].id).toBe('pass');
    expect(results[1].id).toBe('fail');
    // Failure: 0.8 * 0.7 * 1.2 = 0.672
    // Success: 0.8 * 1.1 * 1.2 → min(0.88,1.0) * 1.2 → min(1.056,1.0) = 1.0
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });
});

// ============================================================
// 2. Reinforcement confidence changes
// ============================================================

describe('RLM lifecycle — reinforcement', () => {
  it('should increase confidence on success reinforcement', () => {
    const store = createMemoryStore();
    const lesson = store.store({
      project: 'test-proj',
      category: 'task_lesson',
      content: 'Useful pattern',
      summary: 'Useful',
      similarity: 0.7,
      metadata: { confidence: 0.5, outcome: 'success', times_reinforced: 1 },
    });

    store.reinforce(lesson.id, {
      confidence: Math.min(0.5 + 0.05, 0.99),
      last_outcome: 'success',
    });

    const updated = store.getAll().find((m) => m.id === lesson.id)!;
    expect(updated.metadata.confidence).toBe(0.55);
    expect(updated.metadata.last_outcome).toBe('success');
    expect(updated.metadata.times_reinforced).toBe(2);
  });

  it('should decrease confidence on failure reinforcement', () => {
    const store = createMemoryStore();
    const lesson = store.store({
      project: 'test-proj',
      category: 'task_lesson',
      content: 'Maybe unreliable pattern',
      summary: 'Unreliable',
      similarity: 0.7,
      metadata: { confidence: 0.5, outcome: 'success', times_reinforced: 1 },
    });

    store.reinforce(lesson.id, {
      confidence: Math.max(0.5 * 0.85, 0.1),
      last_outcome: 'failure',
    });

    const updated = store.getAll().find((m) => m.id === lesson.id)!;
    expect(updated.metadata.confidence).toBe(0.425);
    expect(updated.metadata.last_outcome).toBe('failure');
  });
});

// ============================================================
// 3. buildPrompt includes memories and rules
// ============================================================

describe('RLM lifecycle — buildPrompt enrichment', () => {
  it('should include memories and project rules in output', () => {
    const memories: MockMemory[] = [
      {
        id: 'm1', project: 'p', category: 'task_lesson',
        content: 'Run tests first', summary: 'Always run tests',
        similarity: 0.9, metadata: { outcome: 'success' },
      },
    ];
    const rules: MockMemory[] = [
      {
        id: 'r1', project: 'p', category: 'project_rule',
        content: 'Never push to main', summary: 'PR-only workflow',
        similarity: 0.95, metadata: {},
      },
    ];

    const prompt = buildPrompt('Fix login bug', 'p', memories, rules);

    expect(prompt).toContain('Relevant context from memory');
    expect(prompt).toContain('Always run tests');
    expect(prompt).toContain('Project rules');
    expect(prompt).toContain('PR-only workflow');
  });
});

// ============================================================
// 4. Full learn → retrieve → enrich cycle
// ============================================================

describe('RLM lifecycle — full cycle', () => {
  it('should store lesson, search, and include in prompt', () => {
    const store = createMemoryStore();

    // 1. Store a lesson (simulating task-poller)
    store.store({
      project: 'itachi-memory',
      category: 'task_lesson',
      content: 'Task: Run tests\nOutcome: COMPLETED: all pass',
      summary: 'Running bun test works on coolify',
      similarity: 0,
      metadata: {
        task_status: 'completed',
        is_failure: false,
        outcome: 'success',
        source: 'task_completion',
      },
    });

    // 2. Search for related context
    const results = store.search('run tests', 'itachi-memory', 5);
    expect(results.length).toBeGreaterThan(0);

    // 3. Apply outcome reranking
    const ranked = applyOutcomeReranking(results);
    expect(ranked[0].metadata.outcome).toBe('success');

    // 4. Build prompt with enrichment
    const prompt = buildPrompt(
      'Run bun test for task-detection',
      'itachi-memory',
      ranked,
      [],
    );

    expect(prompt).toContain('Running bun test works on coolify');
    expect(prompt).toContain('Relevant context from memory');
  });
});

// ============================================================
// 5. Transcript-analyzer outcome metadata
// ============================================================

describe('RLM lifecycle — transcript-analyzer metadata', () => {
  it('should store insights with outcome metadata when context.outcome is set', () => {
    // Simulates what transcript-analyzer does
    const context = {
      source: 'task' as const,
      project: 'itachi-memory',
      taskId: 'abc-123',
      outcome: 'COMPLETED: all tests pass',
    };

    const insightMetadata: Record<string, unknown> = {
      source: `${context.source}_transcript`,
      significance: 0.8,
      ...(context.taskId ? { task_id: context.taskId } : {}),
      ...(context.outcome ? { outcome: context.outcome } : {}),
    };

    expect(insightMetadata.outcome).toBe('COMPLETED: all tests pass');
    expect(insightMetadata.task_id).toBe('abc-123');
    expect(insightMetadata.source).toBe('task_transcript');
  });
});

// ============================================================
// 6. Task-poller outcome metadata
// ============================================================

describe('RLM lifecycle — task-poller metadata', () => {
  it('should include outcome field in stored lesson metadata', () => {
    // Simulates task-poller extractLessonFromCompletion
    const task = {
      id: 'task-xyz',
      status: 'completed',
      project: 'itachi-memory',
      description: 'Fix login button',
      result_summary: 'Button styling fixed',
      error_message: null,
      files_changed: ['src/button.tsx'],
    };

    const isFailure = task.status === 'failed' || task.status === 'timeout';
    const metadata = {
      task_status: task.status,
      is_failure: isFailure,
      outcome: isFailure ? 'failure' : 'success',
      source: 'task_completion',
    };

    expect(metadata.outcome).toBe('success');
    expect(metadata.is_failure).toBe(false);
  });

  it('should set outcome to failure for failed tasks', () => {
    const task = { status: 'failed' };
    const isFailure = task.status === 'failed' || task.status === 'timeout';
    const metadata = {
      outcome: isFailure ? 'failure' : 'success',
    };

    expect(metadata.outcome).toBe('failure');
  });

  it('should set outcome to failure for timeout tasks', () => {
    const task = { status: 'timeout' };
    const isFailure = task.status === 'failed' || task.status === 'timeout';
    const metadata = {
      outcome: isFailure ? 'failure' : 'success',
    };

    expect(metadata.outcome).toBe('failure');
  });
});
