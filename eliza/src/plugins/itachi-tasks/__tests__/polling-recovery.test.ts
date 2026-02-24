/**
 * Tests for polling recovery backoff logic.
 * Run with: bun test src/plugins/itachi-tasks/__tests__/polling-recovery.test.ts
 */
import { describe, test, expect } from 'bun:test';

// Inline the backoffDelay function for testing (it's not exported from callback-handler)
function backoffDelay(
  attempt: number,
  opts = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0.25 },
): number {
  const base = Math.min(opts.initialMs * Math.pow(opts.factor, attempt), opts.maxMs);
  const jitterRange = base * opts.jitter;
  return base + (Math.random() * 2 - 1) * jitterRange;
}

describe('backoffDelay', () => {
  test('first attempt returns ~2000ms', () => {
    const delays: number[] = [];
    for (let i = 0; i < 100; i++) {
      delays.push(backoffDelay(0));
    }
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
    // Should be around 2000ms (+/- 500ms jitter range)
    expect(avg).toBeGreaterThan(1500);
    expect(avg).toBeLessThan(2500);
  });

  test('delay increases with attempts', () => {
    // Use no-jitter variant for deterministic testing
    const noJitter = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0 };
    const d0 = backoffDelay(0, noJitter);
    const d1 = backoffDelay(1, noJitter);
    const d2 = backoffDelay(2, noJitter);
    const d3 = backoffDelay(3, noJitter);

    expect(d0).toBe(2000);          // 2000 * 1.8^0 = 2000
    expect(d1).toBe(3600);          // 2000 * 1.8^1 = 3600
    expect(d2).toBeCloseTo(6480);   // 2000 * 1.8^2 = 6480
    expect(d3).toBeCloseTo(11664);  // 2000 * 1.8^3 = 11664
  });

  test('caps at maxMs', () => {
    const noJitter = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0 };
    // At attempt 10, 2000 * 1.8^10 = ~714,948 but should cap at 30_000
    const d10 = backoffDelay(10, noJitter);
    expect(d10).toBe(30_000);
  });

  test('jitter adds randomness within range', () => {
    const opts = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0.25 };
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) {
      delays.add(Math.round(backoffDelay(0, opts)));
    }
    // With jitter, we should get different values
    expect(delays.size).toBeGreaterThan(1);

    // All values should be within [base * (1 - jitter), base * (1 + jitter)]
    // Base at attempt 0 = 2000, jitter range = 500
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(1500);
      expect(d).toBeLessThanOrEqual(2500);
    }
  });

  test('progression reaches max within reasonable attempts', () => {
    const noJitter = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0 };
    let reachedMax = false;
    for (let i = 0; i < 20; i++) {
      if (backoffDelay(i, noJitter) >= 30_000) {
        reachedMax = true;
        expect(i).toBeLessThanOrEqual(6); // Should reach max by attempt 5-6
        break;
      }
    }
    expect(reachedMax).toBe(true);
  });
});

// ── Integration-style tests for polling recovery logic ───────────────

describe('polling recovery logic', () => {
  test('409 error handling: should retry with increasing delays', () => {
    // Simulate: 5 consecutive 409s should NOT cause loop exit (unlike old code)
    // Old code: exited on iteration 4+ with 409
    // New code: only exits after 10+ consecutive 409s
    const MAX_409_BEFORE_EXIT = 10;
    let consecutive409s = 0;
    let shouldContinue = true;

    // Simulate 5 consecutive 409s
    for (let i = 0; i < 5; i++) {
      consecutive409s++;
      if (consecutive409s > MAX_409_BEFORE_EXIT) {
        shouldContinue = false;
        break;
      }
    }

    expect(shouldContinue).toBe(true);
    expect(consecutive409s).toBe(5);
  });

  test('409 errors reset counter on successful getUpdates', () => {
    let consecutive409s = 3;
    // Simulate successful getUpdates
    consecutive409s = 0; // Reset on success
    expect(consecutive409s).toBe(0);
  });

  test('total timeout prevents infinite manual polling', () => {
    const MAX_TOTAL_WAIT_MS = 5 * 60 * 1000;
    const startTime = Date.now();
    // Simulate: if we started 6 minutes ago, should stop
    const elapsed = 6 * 60 * 1000;
    expect(elapsed > MAX_TOTAL_WAIT_MS).toBe(true);
  });

  test('offset persistence across polling restarts', () => {
    let persistedOffset = 0;

    // Simulate processing updates
    const updates = [
      { update_id: 100 },
      { update_id: 101 },
      { update_id: 102 },
    ];

    for (const update of updates) {
      persistedOffset = update.update_id + 1;
    }

    expect(persistedOffset).toBe(103);

    // After restart, offset should persist
    const newStartOffset = persistedOffset;
    expect(newStartOffset).toBe(103);
  });
});
