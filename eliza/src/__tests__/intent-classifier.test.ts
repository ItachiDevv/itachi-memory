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

  it('fast-classifies action verbs as task', () => {
    expect(classifyMessage('set up a cron job to scrape hacker news')).toBe('task');
    expect(classifyMessage('can you install chrome on linux')).toBe('task');
    expect(classifyMessage('install google chrome')).toBe('task');
    expect(classifyMessage('deploy the latest build')).toBe('task');
    expect(classifyMessage('please check disk usage')).toBe('task');
  });

  it('returns null for natural language (needs LLM)', () => {
    expect(classifyMessage('hey itachi how are you')).toBeNull();
    expect(classifyMessage('the deployment looks good')).toBeNull();
  });
});
