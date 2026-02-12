import { describe, it, expect } from 'bun:test';

// Pure function tests — no mocking needed.
// We mock @elizaos/core and @supabase/supabase-js only so the module can be imported.

import { mock } from 'bun:test';

mock.module('@supabase/supabase-js', () => ({
  createClient: () => ({}),
}));

mock.module('@elizaos/core', () => ({
  Service: class Service {
    static serviceType = 'base';
    capabilityDescription = '';
  },
}));

import { parseTimeAndMessage, parseActionFromMessage } from '../plugins/itachi-tasks/actions/reminder-commands';

// ============================================================
// parseTimeAndMessage
// ============================================================

describe('parseTimeAndMessage', () => {
  it('parses "9am go to gym" as today 9am', () => {
    const result = parseTimeAndMessage('9am go to gym');
    expect(result).not.toBeNull();
    expect(result!.message).toBe('go to gym');
    expect(result!.remindAt.getHours()).toBe(9);
    expect(result!.remindAt.getMinutes()).toBe(0);
    expect(result!.recurring).toBeNull();
  });

  it('parses "tomorrow 3pm call dentist"', () => {
    const result = parseTimeAndMessage('tomorrow 3pm call dentist');
    expect(result).not.toBeNull();
    expect(result!.message).toBe('call dentist');
    expect(result!.remindAt.getHours()).toBe(15);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result!.remindAt.toDateString()).toBe(tomorrow.toDateString());
    expect(result!.recurring).toBeNull();
  });

  it('parses "in 2h sync repos" as relative time', () => {
    const before = new Date();
    const result = parseTimeAndMessage('in 2h sync repos');
    const after = new Date();

    expect(result).not.toBeNull();
    expect(result!.message).toBe('sync repos');

    // remindAt should be roughly 2h from now (within a few seconds)
    const expectedMin = before.getTime() + 2 * 60 * 60 * 1000 - 5000;
    const expectedMax = after.getTime() + 2 * 60 * 60 * 1000 + 5000;
    expect(result!.remindAt.getTime()).toBeGreaterThan(expectedMin);
    expect(result!.remindAt.getTime()).toBeLessThan(expectedMax);
    expect(result!.recurring).toBeNull();
  });

  it('parses "in 30m take a break" as relative minutes', () => {
    const before = new Date();
    const result = parseTimeAndMessage('in 30m take a break');

    expect(result).not.toBeNull();
    expect(result!.message).toBe('take a break');

    const expectedMin = before.getTime() + 30 * 60 * 1000 - 5000;
    expect(result!.remindAt.getTime()).toBeGreaterThan(expectedMin);
    expect(result!.recurring).toBeNull();
  });

  it('parses "daily 8:30am standup" with recurring prefix', () => {
    const result = parseTimeAndMessage('daily 8:30am standup');
    expect(result).not.toBeNull();
    expect(result!.message).toBe('standup');
    expect(result!.remindAt.getHours()).toBe(8);
    expect(result!.remindAt.getMinutes()).toBe(30);
    expect(result!.recurring).toBe('daily');
  });

  it('parses "weekdays 9am close-done" with weekdays recurring', () => {
    const result = parseTimeAndMessage('weekdays 9am close-done');
    expect(result).not.toBeNull();
    expect(result!.message).toBe('close-done');
    expect(result!.remindAt.getHours()).toBe(9);
    expect(result!.recurring).toBe('weekdays');
  });

  it('parses "weekly 10am review" with weekly recurring', () => {
    const result = parseTimeAndMessage('weekly 10am review');
    expect(result).not.toBeNull();
    expect(result!.message).toBe('review');
    expect(result!.recurring).toBe('weekly');
  });

  it('parses "tomorrow 9:15am check tasks" with minutes', () => {
    const result = parseTimeAndMessage('tomorrow 9:15am check tasks');
    expect(result).not.toBeNull();
    expect(result!.message).toBe('check tasks');
    expect(result!.remindAt.getHours()).toBe(9);
    expect(result!.remindAt.getMinutes()).toBe(15);
  });

  it('returns null for unparseable input "asdfasdf"', () => {
    const result = parseTimeAndMessage('asdfasdf');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseTimeAndMessage('');
    expect(result).toBeNull();
  });

  it('handles suffix time pattern "go to gym at 5pm"', () => {
    const result = parseTimeAndMessage('go to gym at 5pm');
    expect(result).not.toBeNull();
    expect(result!.message).toBe('go to gym');
    expect(result!.remindAt.getHours()).toBe(17);
  });
});

// ============================================================
// parseActionFromMessage
// ============================================================

describe('parseActionFromMessage', () => {
  it('parses "close-done" as close_done action', () => {
    const result = parseActionFromMessage('close-done');
    expect(result.actionType).toBe('close_done');
    expect(result.actionData).toEqual({});
    expect(result.label).toBe('close-done');
  });

  it('parses "close-failed" as close_failed action', () => {
    const result = parseActionFromMessage('close-failed');
    expect(result.actionType).toBe('close_failed');
    expect(result.label).toBe('close-failed');
  });

  it('parses "sync-repos" as sync_repos action', () => {
    const result = parseActionFromMessage('sync-repos');
    expect(result.actionType).toBe('sync_repos');
    expect(result.label).toBe('sync-repos');
  });

  it('parses "recall auth middleware" as recall with query', () => {
    const result = parseActionFromMessage('recall auth middleware');
    expect(result.actionType).toBe('recall');
    expect(result.actionData).toEqual({ query: 'auth middleware' });
    expect(result.label).toBe('recall: auth middleware');
  });

  it('parses "recall lotitachi:auth" as recall with project:query', () => {
    const result = parseActionFromMessage('recall lotitachi:auth');
    expect(result.actionType).toBe('recall');
    expect(result.actionData).toEqual({ project: 'lotitachi', query: 'auth' });
    expect(result.label).toBe('recall: lotitachi:auth');
  });

  it('parses "/status" as custom action (bot command)', () => {
    const result = parseActionFromMessage('/status');
    expect(result.actionType).toBe('custom');
    expect(result.actionData).toEqual({ command: '/status' });
    expect(result.label).toBe('/status');
  });

  it('parses "/repos" as custom action', () => {
    const result = parseActionFromMessage('/repos');
    expect(result.actionType).toBe('custom');
    expect(result.actionData).toEqual({ command: '/repos' });
  });

  it('parses natural language "check for failed tasks" as custom action', () => {
    const result = parseActionFromMessage('check for failed tasks');
    expect(result.actionType).toBe('custom');
    expect(result.actionData).toEqual({ command: 'check for failed tasks' });
    expect(result.label).toBe('check for failed tasks');
  });

  it('parses "recall" alone (no query) as recall action', () => {
    const result = parseActionFromMessage('recall');
    expect(result.actionType).toBe('recall');
    expect(result.actionData).toEqual({});
    expect(result.label).toBe('recall');
  });
});
