import { describe, it, expect } from 'bun:test';
import {
  buildRetryPrompt,
  shouldAutoRetry,
  MAX_RETRIES,
} from '../plugins/itachi-tasks/utils/retry-builder.js';

// ============================================================
// buildRetryPrompt
// ============================================================

describe('buildRetryPrompt', () => {
  it('includes the original task description', () => {
    const prompt = buildRetryPrompt('Fix the login button', 'SSH timeout');
    expect(prompt).toContain('Fix the login button');
  });

  it('includes the failure reason', () => {
    const prompt = buildRetryPrompt('Deploy the app', 'Build failed: missing env var');
    expect(prompt).toContain('Build failed: missing env var');
  });

  it('adds a "try a different approach" instruction', () => {
    const prompt = buildRetryPrompt('Run the tests', 'Test suite timed out');
    expect(prompt).toContain('try a different approach');
  });

  it('mentions that the previous attempt failed', () => {
    const prompt = buildRetryPrompt('Update readme', 'Permission denied');
    expect(prompt).toContain('Previous attempt failed');
  });

  it('returns a string containing both inputs and the instruction', () => {
    const desc = 'Add dark mode toggle';
    const reason = 'npm install failed';
    const prompt = buildRetryPrompt(desc, reason);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain(desc);
    expect(prompt).toContain(reason);
    expect(prompt).toContain('try a different approach');
  });

  it('handles empty failure reason gracefully', () => {
    const prompt = buildRetryPrompt('Run lint', '');
    expect(prompt).toContain('Run lint');
    expect(prompt).toContain('try a different approach');
  });
});

// ============================================================
// shouldAutoRetry
// ============================================================

describe('shouldAutoRetry', () => {
  it('returns true for a task with a timeout error and retry_count=0', () => {
    expect(shouldAutoRetry({ error_message: 'Task timed out after 300s', retry_count: 0 })).toBe(true);
  });

  it('returns true for a task with "build failed" error', () => {
    expect(shouldAutoRetry({ error_message: 'Build failed: exit code 1', retry_count: 0 })).toBe(true);
  });

  it('returns true for a task with "test failed" error', () => {
    expect(shouldAutoRetry({ error_message: 'Test failed: assertion error', retry_count: 1 })).toBe(true);
  });

  it('returns false when retry_count equals MAX_RETRIES', () => {
    expect(shouldAutoRetry({ error_message: 'timeout', retry_count: MAX_RETRIES })).toBe(false);
  });

  it('returns false when retry_count exceeds MAX_RETRIES', () => {
    expect(shouldAutoRetry({ error_message: 'timeout', retry_count: MAX_RETRIES + 1 })).toBe(false);
  });

  it('returns false for "invalid credentials" error (unretryable)', () => {
    expect(shouldAutoRetry({ error_message: 'invalid credentials provided', retry_count: 0 })).toBe(false);
  });

  it('returns false for "repo not found" error (unretryable)', () => {
    expect(shouldAutoRetry({ error_message: 'repo not found: itachi-memory', retry_count: 0 })).toBe(false);
  });

  it('returns true for empty error_message', () => {
    expect(shouldAutoRetry({ error_message: '', retry_count: 0 })).toBe(true);
  });

  it('returns true when error_message is missing (undefined)', () => {
    expect(shouldAutoRetry({ retry_count: 0 })).toBe(true);
  });

  it('treats undefined retry_count as 0 (retryable)', () => {
    expect(shouldAutoRetry({ error_message: 'timeout' })).toBe(true);
  });

  it('returns true for retry_count=1 with a generic error', () => {
    expect(shouldAutoRetry({ error_message: 'Process exited with code 1', retry_count: 1 })).toBe(true);
  });

  it('is case-insensitive when checking unretryable patterns', () => {
    expect(shouldAutoRetry({ error_message: 'Invalid Credentials', retry_count: 0 })).toBe(false);
    expect(shouldAutoRetry({ error_message: 'Repo Not Found', retry_count: 0 })).toBe(false);
  });

  it('MAX_RETRIES constant is 2', () => {
    expect(MAX_RETRIES).toBe(2);
  });
});
