import { describe, it, expect, beforeAll } from 'bun:test';
import { getHealthStatus } from '../plugins/itachi-tasks/utils/health-check.js';

describe('getHealthStatus', () => {
  let before: number;

  beforeAll(() => {
    before = Date.now();
  });

  it('returns a positive uptime', () => {
    const status = getHealthStatus();
    expect(status.uptime).toBeGreaterThan(0);
  });

  it('returns memory usage with expected fields', () => {
    const { memoryUsage } = getHealthStatus();
    expect(memoryUsage.rss).toBeGreaterThan(0);
    expect(memoryUsage.heapTotal).toBeGreaterThan(0);
    expect(memoryUsage.heapUsed).toBeGreaterThan(0);
  });

  it('returns a valid ISO timestamp', () => {
    const { timestamp } = getHealthStatus();
    expect(() => new Date(timestamp)).not.toThrow();
    expect(new Date(timestamp).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('returns a fresh timestamp on each call', async () => {
    const a = getHealthStatus();
    await new Promise((r) => setTimeout(r, 10));
    const b = getHealthStatus();
    expect(new Date(b.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(a.timestamp).getTime());
  });
});
