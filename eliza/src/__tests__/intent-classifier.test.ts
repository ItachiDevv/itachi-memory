import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../plugins/itachi-tasks/services/task-orchestrator';

describe('classifyMessage (unit, no LLM)', () => {
  it('classifies /task commands as task', () => {
    expect(classifyMessage('/task itachi-memory fix the bug')).toBe('task');
  });

  it('classifies slash commands as their own type', () => {
    expect(classifyMessage('/help')).toBe('command');
    expect(classifyMessage('/status abc123')).toBe('command');
    expect(classifyMessage('/brain')).toBe('command');
  });

  it('returns null for natural language (needs LLM)', () => {
    expect(classifyMessage('set up a cron job to scrape hacker news')).toBeNull();
    expect(classifyMessage('hey itachi how are you')).toBeNull();
  });
});
