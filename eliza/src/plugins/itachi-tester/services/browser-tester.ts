// TODO: This entire browser test suite needs to be rewritten once we know the actual
// agent-browser CLI API. The previous implementation used completely fabricated CLI flags
// (--wait, --get-text, search, click-first-result, get-last-message, --press-enter, --from-bot)
// that do not exist in the real agent-browser tool.
//
// Once the real agent-browser API is documented/verified, rewrite the following tests:
// - checkTelegramLogin: open Telegram Web and verify logged-in state
// - navigateToBot: search for and open a bot chat
// - runMessageTest: send messages and verify bot responses (ping, /task, queries, edge cases)

import type { TestResult } from '../types.js';

export interface BrowserTesterOptions {
  botUsername: string;
}

export async function runBrowserTests(_opts: BrowserTesterOptions): Promise<TestResult[]> {
  // Return an empty passing result — browser tests are disabled until agent-browser API is known
  return [{
    name: 'browser-suite-disabled',
    status: 'skip',
    durationMs: 0,
    message: 'Browser test suite commented out: agent-browser CLI API needs verification before rewrite',
  }];
}
