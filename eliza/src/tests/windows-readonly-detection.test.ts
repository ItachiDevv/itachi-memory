// @ts-nocheck
/**
 * Tests for the isReadOnlyTask regex pattern from task-executor-service.ts (lines 1197-1198).
 *
 * Pattern logic:
 *   const descLower = (task.description || '').toLowerCase();
 *   const isReadOnlyTask =
 *     /\b(read|check|list|show|report|status|log|uptime|count|summarize|describe|what is|inspect|verify)\b/.test(descLower)
 *     && !/\b(create|write|modify|update|add|fix|change|edit|set up|install|deploy)\b/.test(descLower);
 */

import { describe, it, expect } from 'bun:test';

function isReadOnlyTask(description: string): boolean {
  const descLower = description.toLowerCase();
  return (
    /\b(read|check|list|show|report|status|log|uptime|count|summarize|describe|what is|inspect|verify)\b/.test(descLower) &&
    !/\b(create|write|modify|update|add|fix|change|edit|set up|install|deploy)\b/.test(descLower)
  );
}

describe('isReadOnlyTask regex pattern', () => {
  // ── Pure read-only tasks (should return true) ──────────────────────
  it('should detect "check logs" as read-only', () => {
    expect(isReadOnlyTask('check logs')).toBe(true);
  });

  it('should detect "list all files in the repo" as read-only', () => {
    expect(isReadOnlyTask('list all files in the repo')).toBe(true);
  });

  it('should detect "show current status" as read-only', () => {
    expect(isReadOnlyTask('show current status')).toBe(true);
  });

  it('should detect "report on system health" as read-only', () => {
    expect(isReadOnlyTask('report on system health')).toBe(true);
  });

  it('should detect "summarize recent changes" as read-only', () => {
    expect(isReadOnlyTask('summarize recent changes')).toBe(true);
  });

  it('should detect "inspect the database schema" as read-only', () => {
    expect(isReadOnlyTask('inspect the database schema')).toBe(true);
  });

  it('should detect "verify the configuration is correct" as read-only', () => {
    expect(isReadOnlyTask('verify the configuration is correct')).toBe(true);
  });

  // ── Edge cases: read-only keyword + write keyword (should return false) ──
  it('should NOT detect "check and fix the bug" as read-only', () => {
    expect(isReadOnlyTask('check and fix the bug')).toBe(false);
  });

  it('should NOT detect "list then create new files" as read-only', () => {
    expect(isReadOnlyTask('list then create new files')).toBe(false);
  });

  it('should NOT detect "verify and deploy to production" as read-only', () => {
    expect(isReadOnlyTask('verify and deploy to production')).toBe(false);
  });

  it('should NOT detect "update the report" as read-only', () => {
    expect(isReadOnlyTask('update the report')).toBe(false);
  });

  it('should NOT detect "create a status dashboard" as read-only', () => {
    expect(isReadOnlyTask('create a status dashboard')).toBe(false);
  });

  it('should NOT detect "describe then modify the service" as read-only', () => {
    expect(isReadOnlyTask('describe then modify the service')).toBe(false);
  });

  // ── No read-only keywords at all (should return false) ──────────────
  it('should NOT detect "run all unit tests" as read-only', () => {
    expect(isReadOnlyTask('run all unit tests')).toBe(false);
  });

  it('should NOT detect "write a summary report" as read-only', () => {
    // "report" is a read-only keyword but "write" is a write keyword — write wins
    expect(isReadOnlyTask('write a summary report')).toBe(false);
  });
});
