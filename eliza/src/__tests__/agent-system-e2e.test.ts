/**
 * E2E Browser Test Suite for Itachi Agent System
 *
 * Tests the agent system via web.telegram.org by sending real messages
 * to the Itachi bot and verifying responses.
 *
 * Prerequisites:
 * - Telegram web must be open and logged in
 * - The itachi-agents plugin must be deployed to Hetzner
 * - The agent-system.sql migration must be applied
 *
 * Run with: bun test src/__tests__/agent-system-e2e.test.ts
 * Or manually via Claude Code with Chrome MCP / Playwright MCP
 *
 * These tests are designed to be run interactively using the
 * browser automation tools (Chrome MCP or Playwright MCP).
 * They define the test scenarios — the actual browser interaction
 * is performed by calling the functions from the test runner
 * or via manual invocation with browser MCP tools.
 */

import { describe, it, expect } from 'bun:test';

// ============================================================
// E2E Test Definitions
// These describe the scenarios to execute in the browser.
// ============================================================

/** Each E2E test case */
interface E2ETestCase {
  name: string;
  description: string;
  /** Message to send to the bot */
  sendMessage: string;
  /** Patterns that should appear in the bot's response */
  expectedPatterns: RegExp[];
  /** Patterns that should NOT appear (error indicators) */
  unexpectedPatterns?: RegExp[];
  /** Minimum wait time (ms) for the bot to respond */
  waitMs: number;
  /** Whether this test depends on a previous test's state */
  dependsOn?: string;
}

const E2E_TESTS: E2ETestCase[] = [
  // ---- Agent Spawning ----
  {
    name: 'spawn-code-reviewer',
    description: 'Spawn a code-reviewer subagent to analyze a simple task',
    sendMessage: 'delegate to code-reviewer: analyze the error handling patterns in the reminder-commands module',
    expectedPatterns: [
      /code.?reviewer/i,
      /spawn/i,
    ],
    unexpectedPatterns: [
      /not found/i,
      /error.*service/i,
    ],
    waitMs: 15_000,
  },
  {
    name: 'spawn-researcher',
    description: 'Spawn a researcher subagent for analysis',
    sendMessage: 'have the researcher investigate the pros and cons of WebSockets vs Server-Sent Events for real-time updates',
    expectedPatterns: [
      /researcher/i,
      /spawn/i,
    ],
    waitMs: 15_000,
  },

  // ---- Agent Listing ----
  {
    name: 'list-agents',
    description: 'List active and recent subagent runs',
    sendMessage: 'show active agents',
    expectedPatterns: [
      /agent/i,
    ],
    waitMs: 10_000,
    dependsOn: 'spawn-code-reviewer',
  },

  // ---- Agent Messages ----
  {
    name: 'check-messages',
    description: 'Check for unread inter-agent messages',
    sendMessage: 'check agent messages',
    expectedPatterns: [
      /message/i,
    ],
    waitMs: 10_000,
    dependsOn: 'spawn-code-reviewer',
  },
  {
    name: 'send-message-to-researcher',
    description: 'Send a follow-up message to the researcher',
    sendMessage: 'tell the researcher to also consider MQTT as an option',
    expectedPatterns: [
      /message.*sent|sent.*message/i,
      /researcher/i,
    ],
    waitMs: 10_000,
  },

  // ---- Cron Management ----
  {
    name: 'create-cron-job',
    description: 'Schedule a recurring health check',
    sendMessage: 'schedule a health check every 30 minutes using devops',
    expectedPatterns: [
      /cron|schedule|created/i,
      /30/,
    ],
    waitMs: 15_000,
  },
  {
    name: 'list-cron-jobs',
    description: 'List all scheduled cron jobs',
    sendMessage: 'list scheduled jobs',
    expectedPatterns: [
      /schedule|cron|job/i,
    ],
    waitMs: 10_000,
    dependsOn: 'create-cron-job',
  },
  {
    name: 'cancel-cron-job',
    description: 'Cancel the health check cron job',
    sendMessage: 'cancel the health check cron job',
    expectedPatterns: [
      /cancel|disabled|stopped/i,
    ],
    waitMs: 10_000,
    dependsOn: 'create-cron-job',
  },

  // ---- Error Handling ----
  {
    name: 'spawn-invalid-profile',
    description: 'Attempt to spawn with a nonexistent profile',
    sendMessage: 'delegate to quantum-physicist: solve P=NP',
    expectedPatterns: [
      /not found|available profiles|couldn't determine/i,
    ],
    waitMs: 10_000,
  },
];

// ============================================================
// Unit-testable validation of E2E test definitions
// ============================================================

describe('E2E Test Definitions', () => {
  it('all tests have required fields', () => {
    for (const test of E2E_TESTS) {
      expect(test.name).toBeTruthy();
      expect(test.sendMessage).toBeTruthy();
      expect(test.expectedPatterns.length).toBeGreaterThan(0);
      expect(test.waitMs).toBeGreaterThan(0);
    }
  });

  it('all test names are unique', () => {
    const names = E2E_TESTS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('dependencies reference existing tests', () => {
    const names = new Set(E2E_TESTS.map(t => t.name));
    for (const test of E2E_TESTS) {
      if (test.dependsOn) {
        expect(names.has(test.dependsOn)).toBe(true);
      }
    }
  });

  it('expected patterns are valid regexes', () => {
    for (const test of E2E_TESTS) {
      for (const pat of test.expectedPatterns) {
        expect(pat instanceof RegExp).toBe(true);
        // Should not throw when tested
        expect(() => pat.test('sample text')).not.toThrow();
      }
    }
  });
});

// ============================================================
// Export for use by browser automation scripts
// ============================================================

export { E2E_TESTS, type E2ETestCase };

/**
 * Helper: validate a bot response against a test case
 */
export function validateResponse(testCase: E2ETestCase, responseText: string): {
  passed: boolean;
  matchedPatterns: string[];
  missingPatterns: string[];
  unexpectedMatches: string[];
} {
  const matchedPatterns: string[] = [];
  const missingPatterns: string[] = [];
  const unexpectedMatches: string[] = [];

  for (const pat of testCase.expectedPatterns) {
    if (pat.test(responseText)) {
      matchedPatterns.push(pat.source);
    } else {
      missingPatterns.push(pat.source);
    }
  }

  if (testCase.unexpectedPatterns) {
    for (const pat of testCase.unexpectedPatterns) {
      if (pat.test(responseText)) {
        unexpectedMatches.push(pat.source);
      }
    }
  }

  return {
    passed: missingPatterns.length === 0 && unexpectedMatches.length === 0,
    matchedPatterns,
    missingPatterns,
    unexpectedMatches,
  };
}

// Quick unit test for the helper
describe('validateResponse helper', () => {
  const testCase: E2ETestCase = {
    name: 'test',
    description: 'test',
    sendMessage: 'test',
    expectedPatterns: [/spawned/i, /code.?reviewer/i],
    unexpectedPatterns: [/error/i],
    waitMs: 1000,
  };

  it('passes when all patterns match and no unexpected', () => {
    const result = validateResponse(testCase, 'Spawned Code Reviewer agent successfully');
    expect(result.passed).toBe(true);
    expect(result.matchedPatterns).toHaveLength(2);
    expect(result.missingPatterns).toHaveLength(0);
  });

  it('fails when expected pattern missing', () => {
    const result = validateResponse(testCase, 'Something happened');
    expect(result.passed).toBe(false);
    expect(result.missingPatterns.length).toBeGreaterThan(0);
  });

  it('fails when unexpected pattern found', () => {
    const result = validateResponse(testCase, 'Spawned Code Reviewer but got error');
    expect(result.passed).toBe(false);
    expect(result.unexpectedMatches).toContain('error');
  });
});
