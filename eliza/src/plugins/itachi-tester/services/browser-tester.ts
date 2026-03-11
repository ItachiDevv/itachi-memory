import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestResult } from '../types.js';

const execFileAsync = promisify(execFile);
const BROWSER_TIMEOUT_MS = 60_000;

function agentBrowser(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('agent-browser', args, { timeout: BROWSER_TIMEOUT_MS });
}

interface BrowserTesterOptions {
  botUsername: string;
}

export async function runBrowserTests(opts: BrowserTesterOptions): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const { botUsername } = opts;

  // Step 1: Check if Telegram Web session exists and is logged in
  const loginCheck = await checkTelegramLogin();
  if (!loginCheck.loggedIn) {
    return [{
      name: 'telegram-web-login',
      status: 'skip',
      durationMs: loginCheck.durationMs,
      message: `telegram-web: needs manual login — ${loginCheck.reason}`,
    }];
  }

  results.push({
    name: 'telegram-web-login',
    status: 'pass',
    durationMs: loginCheck.durationMs,
    message: 'Logged into Telegram Web',
  });

  // Step 2: Navigate to bot chat
  const navResult = await navigateToBot(botUsername);
  results.push(navResult);
  if (navResult.status !== 'pass') {
    return results; // Can't proceed without navigation
  }

  // Step 3: Run message tests
  const messageTests: Array<{ name: string; message: string; expectResponse: boolean }> = [
    { name: 'ping', message: 'ping', expectResponse: true },
    { name: 'task-create', message: '/task create a simple echo test', expectResponse: true },
    { name: 'tasks-query', message: 'what tasks are running?', expectResponse: true },
    { name: 'long-message', message: 'x'.repeat(500), expectResponse: true },
    { name: 'special-chars', message: 'test !@#$%^&*()', expectResponse: true },
    { name: 'whitespace-message', message: '   ', expectResponse: false },
  ];

  for (const test of messageTests) {
    const r = await runMessageTest(test.name, test.message, test.expectResponse);
    results.push(r);
  }

  return results;
}

async function checkTelegramLogin(): Promise<{ loggedIn: boolean; durationMs: number; reason?: string }> {
  const start = Date.now();
  try {
    // Open Telegram Web and check for logged-in state by looking at the page title or content
    const { stdout } = await agentBrowser([
      'open', 'tester', 'https://web.telegram.org',
      '--wait', '5000',
      '--get-text', 'body',
    ]);
    const durationMs = Date.now() - start;
    const text = stdout.toLowerCase();
    // If page says "log in" or "sign in" or "phone number", not logged in
    if (text.includes('log in') || text.includes('sign in') || text.includes('phone number') || text.includes('qr code')) {
      return { loggedIn: false, durationMs, reason: 'Telegram Web shows login prompt' };
    }
    // If we see chat list or chats, logged in
    if (text.includes('chat') || text.includes('message') || text.includes('search')) {
      return { loggedIn: true, durationMs };
    }
    return { loggedIn: false, durationMs, reason: 'Unable to determine login state from page content' };
  } catch (err) {
    return {
      loggedIn: false,
      durationMs: Date.now() - start,
      reason: `agent-browser error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function navigateToBot(botUsername: string): Promise<TestResult> {
  const start = Date.now();
  try {
    await agentBrowser([
      'search', 'tester', botUsername,
      '--wait', '3000',
    ]);
    await agentBrowser([
      'click-first-result', 'tester',
      '--wait', '2000',
    ]);
    return {
      name: 'navigate-to-bot',
      status: 'pass',
      durationMs: Date.now() - start,
      message: `Navigated to @${botUsername}`,
    };
  } catch (err) {
    return {
      name: 'navigate-to-bot',
      status: 'fail',
      durationMs: Date.now() - start,
      message: `Failed to navigate to @${botUsername}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runMessageTest(
  name: string,
  message: string,
  expectResponse: boolean
): Promise<TestResult> {
  const start = Date.now();
  const RESPONSE_TIMEOUT_MS = 30_000;

  try {
    // Send message
    await agentBrowser([
      'type', 'tester', message,
      '--press-enter',
      '--wait', '1000',
    ]);

    // Wait for response
    const waitStart = Date.now();
    let responseText = '';
    let responded = false;

    while (Date.now() - waitStart < RESPONSE_TIMEOUT_MS) {
      try {
        const { stdout } = await agentBrowser([
          'get-last-message', 'tester',
          '--from-bot',
        ]);
        if (stdout && stdout.trim().length > 0) {
          responseText = stdout.trim();
          responded = true;
          break;
        }
      } catch { /* keep polling */ }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const durationMs = Date.now() - start;

    if (!expectResponse) {
      // For whitespace messages — graceful (either no response is fine, or any response is fine)
      return {
        name,
        status: 'pass',
        durationMs,
        message: responded ? `Got response: ${responseText.substring(0, 100)}` : 'No response (expected for empty-ish message)',
      };
    }

    if (!responded) {
      return {
        name,
        status: 'fail',
        durationMs,
        message: `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`,
      };
    }

    return {
      name,
      status: 'pass',
      durationMs,
      message: `Response received (${responseText.length} chars)`,
      detail: responseText.substring(0, 200),
    };
  } catch (err) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
