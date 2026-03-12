/**
 * Unit tests for task detection functions in create-task.ts.
 * Tests extractTaskFromUserMessage and detectSelfReference with real-world inputs.
 */
import { describe, it, expect } from 'bun:test';
import { extractTaskFromUserMessage, detectSelfReference } from '../plugins/itachi-tasks/actions/create-task.js';

const KNOWN_PROJECTS = ['itachi-memory', 'lotitachi', 'elizapets', 'my-app'];

describe('extractTaskFromUserMessage', () => {
  it('matches project + action verb "deploy"', () => {
    const result = extractTaskFromUserMessage('deploy itachi-memory to production', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
    expect(result![0].description).toContain('deploy');
  });

  it('matches SSH target "coolify" + action verb "give"', () => {
    const result = extractTaskFromUserMessage('give me the latest env variables from the coolify env', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
    expect(result![0].machine).toBe('coolify');
  });

  it('matches project + "audit"', () => {
    const result = extractTaskFromUserMessage('run a code audit on itachi-memory', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
  });

  it('returns null for pure question without action verb', () => {
    const result = extractTaskFromUserMessage('what time is it?', KNOWN_PROJECTS);
    expect(result).toBeNull();
  });

  it('returns null for weather question', () => {
    const result = extractTaskFromUserMessage('how is the weather?', KNOWN_PROJECTS);
    expect(result).toBeNull();
  });

  it('matches SSH target "coolify" + "show"', () => {
    const result = extractTaskFromUserMessage('show me the logs on coolify', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
    expect(result![0].machine).toBe('coolify');
  });

  it('matches SSH target "hetzner" + "restart"', () => {
    const result = extractTaskFromUserMessage('restart the bot on hetzner', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
    expect(result![0].machine).toBe('hetzner');
  });

  it('matches SSH target "mac" + "check"', () => {
    const result = extractTaskFromUserMessage('check disk space on mac', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
    expect(result![0].machine).toBe('mac');
  });

  it('returns null for too-short messages', () => {
    const result = extractTaskFromUserMessage('hey', KNOWN_PROJECTS);
    expect(result).toBeNull();
  });

  it('matches project + "fetch"', () => {
    const result = extractTaskFromUserMessage('fetch the latest changes from itachi-memory', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
  });

  it('matches SSH target "windows" + "install"', () => {
    const result = extractTaskFromUserMessage('install the new dependency on windows machine', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].machine).toBe('windows');
  });

  it('matches SSH target "server" + "monitor"', () => {
    const result = extractTaskFromUserMessage('monitor the server CPU usage and report back', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].machine).toBe('server');
  });

  it('prefers project match over SSH target match', () => {
    // When both a project and SSH target are mentioned, project takes priority
    const result = extractTaskFromUserMessage('deploy itachi-memory on coolify', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
  });

  it('matches "list" as an action verb with SSH target', () => {
    const result = extractTaskFromUserMessage('list all running containers on vps', KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].machine).toBe('vps');
  });

  it('returns null for question-only with SSH target but no action verb', () => {
    // "what is the status of coolify?" → question syntax, no action verb
    const result = extractTaskFromUserMessage('what is coolify?', KNOWN_PROJECTS);
    expect(result).toBeNull();
  });
});

describe('detectSelfReference', () => {
  it('detects "fix your code" as self-reference', () => {
    const result = detectSelfReference('fix your code to handle errors better', [], KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
  });

  it('detects "improve yourself" as self-reference', () => {
    const result = detectSelfReference('improve yourself to be more helpful', [], KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
  });

  it('returns null for questions about capabilities (no action)', () => {
    // "what are your capabilities?" is a question — no self-reference pattern match
    const result = detectSelfReference('what are your capabilities?', [], KNOWN_PROJECTS);
    expect(result).toBeNull();
  });

  it('detects "update your plugins"', () => {
    const result = detectSelfReference('update your plugins to support the new API', [], KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
  });

  it('returns null when itachi-memory is not in known projects', () => {
    const result = detectSelfReference('fix your code', [], ['other-project']);
    expect(result).toBeNull();
  });

  it('detects "evolve yourself"', () => {
    const result = detectSelfReference('evolve yourself to handle more edge cases', [], KNOWN_PROJECTS);
    expect(result).not.toBeNull();
    expect(result![0].project).toBe('itachi-memory');
  });
});

// ============================================================
// Cron request detection — CREATE_TASK handles cron scheduling inline
// Mirrors the isCronRequest regex from create-task.ts validate()
// ============================================================

describe('isCronRequest routing — CREATE_TASK handles cron inline', () => {
  function isCronRequest(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(schedule|set up)\b/i.test(lower)
      && /\b(daily|weekly|hourly|every\s+\d|every\s+(morning|evening|hour|day|week|month)|at\s+\d{1,2}\s*(am|pm)|recurring|cron)\b/i.test(lower);
  }

  // Should be recognized as cron (CREATE_TASK creates recurring reminder)
  it('detects "Schedule a daily task at 9am UTC"', () => {
    expect(isCronRequest('Schedule a daily task at 9am UTC that checks disk space')).toBe(true);
  });

  it('detects "schedule a weekly report every Monday"', () => {
    expect(isCronRequest('schedule a weekly report every Monday at 10am')).toBe(true);
  });

  it('detects "set up a recurring health check every 30 minutes"', () => {
    expect(isCronRequest('set up a recurring health check every 30 minutes')).toBe(true);
  });

  it('detects "schedule hourly backup"', () => {
    expect(isCronRequest('schedule an hourly backup of the database')).toBe(true);
  });

  it('detects "schedule every morning"', () => {
    expect(isCronRequest('schedule a git pull every morning')).toBe(true);
  });

  it('detects "set up a cron job"', () => {
    expect(isCronRequest('set up a cron job to clean temp files')).toBe(true);
  });

  it('detects "schedule at 3pm daily"', () => {
    expect(isCronRequest('schedule at 3pm daily to run tests')).toBe(true);
  });

  // Should NOT be cron (CREATE_TASK handles normally)
  it('does not match one-time "schedule a task to fix the bug"', () => {
    expect(isCronRequest('schedule a task to fix the login bug')).toBe(false);
  });

  it('does not match "create a task on coolify"', () => {
    expect(isCronRequest('create a task on coolify to deploy the app')).toBe(false);
  });

  it('does not match plain imperative "check disk space on coolify"', () => {
    expect(isCronRequest('check disk space on coolify and report')).toBe(false);
  });

  it('does not match "add a test for the scheduler"', () => {
    expect(isCronRequest('add a test for the scheduler module')).toBe(false);
  });
});
