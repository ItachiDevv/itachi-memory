import { describe, it, expect } from 'bun:test';

// ============================================================
// Tests for applyOutcomeReranking logic (mirrored from memory-service.ts)
// Verifies outcome-based and category-based similarity reranking.
// ============================================================

interface MockMemory {
  id: string;
  category: string;
  similarity: number;
  metadata?: Record<string, unknown>;
  summary?: string;
}

// Category boosts mirrored from memory-service.ts
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

/** Mirror of applyOutcomeReranking from MemoryService */
function applyOutcomeReranking(results: MockMemory[]): MockMemory[] {
  return results
    .map((m) => {
      const outcomeVal = m.metadata?.outcome;
      let sim = m.similarity ?? 0.5;

      // Outcome reranking
      if (outcomeVal === 'success') {
        sim = Math.min(sim * 1.1, 1.0);
      } else if (outcomeVal === 'failure') {
        sim = sim * 0.7;
      }

      // Category reranking
      const catBoost = CATEGORY_BOOST[m.category] ?? 1.0;
      sim = Math.min(sim * catBoost, 1.0);

      return { ...m, similarity: sim };
    })
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
}

// ============================================================
// 1. Outcome-based reranking
// ============================================================

describe('Outcome reranking', () => {
  it('should boost success outcome by 1.1x', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'conversation', similarity: 0.8, metadata: { outcome: 'success' } },
    ]);
    // 0.8 * 1.1 = 0.88, then * 1.05 (conversation) = 0.924
    expect(results[0].similarity).toBeCloseTo(0.924, 3);
  });

  it('should demote failure outcome by 0.7x', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'conversation', similarity: 0.8, metadata: { outcome: 'failure' } },
    ]);
    // 0.8 * 0.7 = 0.56, then * 1.05 (conversation) = 0.588
    expect(results[0].similarity).toBeCloseTo(0.588, 3);
  });

  it('should not modify similarity when no outcome metadata', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'conversation', similarity: 0.8, metadata: {} },
    ]);
    // 0.8 * 1.05 (conversation) = 0.84
    expect(results[0].similarity).toBeCloseTo(0.84, 3);
  });
});

// ============================================================
// 2. Category-based reranking
// ============================================================

describe('Category reranking', () => {
  it('should boost project_rule by 1.25x', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'project_rule', similarity: 0.8, metadata: {} },
    ]);
    expect(results[0].similarity).toBeCloseTo(1.0, 3); // 0.8 * 1.25 = 1.0 (capped)
  });

  it('should boost task_lesson by 1.20x', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'task_lesson', similarity: 0.7, metadata: {} },
    ]);
    expect(results[0].similarity).toBeCloseTo(0.84, 3); // 0.7 * 1.20 = 0.84
  });

  it('should demote code_change by 0.85x', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'code_change', similarity: 0.8, metadata: {} },
    ]);
    expect(results[0].similarity).toBeCloseTo(0.68, 3); // 0.8 * 0.85 = 0.68
  });

  it('should use 1.0 multiplier for unknown categories', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'custom_category', similarity: 0.75, metadata: {} },
    ]);
    expect(results[0].similarity).toBeCloseTo(0.75, 3);
  });
});

// ============================================================
// 3. Combined outcome + category
// ============================================================

describe('Combined outcome + category multipliers', () => {
  it('should apply both success boost and category boost', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'task_lesson', similarity: 0.7, metadata: { outcome: 'success' } },
    ]);
    // 0.7 * 1.1 = 0.77, then * 1.20 = 0.924
    expect(results[0].similarity).toBeCloseTo(0.924, 3);
  });

  it('should apply both failure demote and category demote', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'code_change', similarity: 0.8, metadata: { outcome: 'failure' } },
    ]);
    // 0.8 * 0.7 = 0.56, then * 0.85 = 0.476
    expect(results[0].similarity).toBeCloseTo(0.476, 3);
  });
});

// ============================================================
// 4. Capping and sorting
// ============================================================

describe('Capping and sorting', () => {
  it('should cap similarity at 1.0', () => {
    const results = applyOutcomeReranking([
      { id: '1', category: 'project_rule', similarity: 0.95, metadata: { outcome: 'success' } },
    ]);
    // 0.95 * 1.1 = 1.045 → capped to 1.0, then * 1.25 = 1.25 → capped to 1.0
    expect(results[0].similarity).toBeLessThanOrEqual(1.0);
  });

  it('should re-sort by adjusted similarity descending', () => {
    const results = applyOutcomeReranking([
      { id: 'low', category: 'code_change', similarity: 0.9, metadata: { outcome: 'failure' } },
      { id: 'high', category: 'project_rule', similarity: 0.6, metadata: { outcome: 'success' } },
    ]);
    // low: 0.9 * 0.7 * 0.85 = 0.5355
    // high: 0.6 * 1.1 * 1.25 = 0.825 (capped)
    expect(results[0].id).toBe('high');
    expect(results[1].id).toBe('low');
  });

  it('should handle empty results array', () => {
    const results = applyOutcomeReranking([]);
    expect(results).toHaveLength(0);
  });
});
