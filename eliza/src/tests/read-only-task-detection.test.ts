/**
 * Unit tests for the isReadOnlyTask regex pattern from task-executor-service.ts.
 *
 * The logic (mirrored from the service):
 *   const descLower = (task.description || '').toLowerCase();
 *   const isReadOnlyTask =
 *     /\b(read|check|list|show|report|status|log|uptime|count|summarize|describe|what is|inspect|verify)\b/.test(descLower)
 *     && !/\b(create|write|modify|update|add|fix|change|edit|set up|install|deploy)\b/.test(descLower);
 */
import { describe, it, expect } from 'bun:test';

const READ_ONLY_POSITIVE = /\b(read|check|list|show|report|status|log|uptime|count|summarize|describe|what is|inspect|verify)\b/;
const READ_ONLY_NEGATIVE = /\b(create|write|modify|update|add|fix|change|edit|set up|install|deploy)\b/;

function isReadOnlyTask(description: string): boolean {
  const descLower = (description || '').toLowerCase();
  return READ_ONLY_POSITIVE.test(descLower) && !READ_ONLY_NEGATIVE.test(descLower);
}

describe('isReadOnlyTask', () => {
  // --- True cases: read-only tasks ---

  it('returns true for "check the uptime"', () => {
    expect(isReadOnlyTask('check the uptime')).toBe(true);
  });

  it('returns true for "list all running containers"', () => {
    expect(isReadOnlyTask('list all running containers')).toBe(true);
  });

  it('returns true for "show the logs on coolify"', () => {
    expect(isReadOnlyTask('show the logs on coolify')).toBe(true);
  });

  it('returns true for "read the config file"', () => {
    expect(isReadOnlyTask('read the config file')).toBe(true);
  });

  it('returns true for "report memory and CPU usage"', () => {
    expect(isReadOnlyTask('report memory and CPU usage')).toBe(true);
  });

  it('returns true for "inspect the database tables"', () => {
    expect(isReadOnlyTask('inspect the database tables')).toBe(true);
  });

  it('returns true for "summarize recent errors"', () => {
    expect(isReadOnlyTask('summarize recent errors')).toBe(true);
  });

  it('returns true for "verify the service is running"', () => {
    expect(isReadOnlyTask('verify the service is running')).toBe(true);
  });

  it('returns true for "what is the status of the bot"', () => {
    expect(isReadOnlyTask('what is the status of the bot')).toBe(true);
  });

  it('returns true for "describe the schema"', () => {
    expect(isReadOnlyTask('describe the schema')).toBe(true);
  });

  // --- False cases: write/modify tasks ---

  it('returns false for "create and check the file" (create overrides check)', () => {
    expect(isReadOnlyTask('create and check the file')).toBe(false);
  });

  it('returns true for "just check" (no write keyword — contrast with "create and check")', () => {
    expect(isReadOnlyTask('just check')).toBe(true);
  });

  it('returns false for "update the config"', () => {
    expect(isReadOnlyTask('update the config')).toBe(false);
  });

  it('returns false for "deploy the app"', () => {
    expect(isReadOnlyTask('deploy the app')).toBe(false);
  });

  it('returns false for "verify and fix the bug" (fix overrides verify)', () => {
    expect(isReadOnlyTask('verify and fix the bug')).toBe(false);
  });

  it('returns false for "summarize and modify the output" (modify overrides summarize)', () => {
    expect(isReadOnlyTask('summarize and modify the output')).toBe(false);
  });

  it('returns false for "write a new script"', () => {
    expect(isReadOnlyTask('write a new script')).toBe(false);
  });

  it('returns false for "add a new feature"', () => {
    expect(isReadOnlyTask('add a new feature')).toBe(false);
  });

  it('returns false for "install dependencies"', () => {
    expect(isReadOnlyTask('install dependencies')).toBe(false);
  });

  // --- Edge cases ---

  it('returns false for empty string (no positive keyword)', () => {
    expect(isReadOnlyTask('')).toBe(false);
  });

  it('returns false for unrelated description with no keywords', () => {
    expect(isReadOnlyTask('run the migrations')).toBe(false);
  });

  it('is case-insensitive: "CHECK the STATUS" is read-only', () => {
    expect(isReadOnlyTask('CHECK the STATUS')).toBe(true);
  });

  it('is case-insensitive: "CREATE and Check" is NOT read-only', () => {
    expect(isReadOnlyTask('CREATE and Check')).toBe(false);
  });

  it('does not match partial words: "recheck" is NOT matched as "check" via word boundary', () => {
    // "recheck" does not have \b before "check" — but "re" ends with a word char so no boundary
    // Actually \bcheck\b in "recheck" — let's verify: 'recheck' → no \b before 'check'
    // so READ_ONLY_POSITIVE should NOT match 'recheck' alone
    expect(isReadOnlyTask('recheck the output')).toBe(false);
  });

  it('matches "count" as a standalone read-only keyword', () => {
    expect(isReadOnlyTask('count the records in the table')).toBe(true);
  });
});
