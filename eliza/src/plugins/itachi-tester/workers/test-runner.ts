import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { TestRun, TestSuite } from '../types.js';
import { runBrowserTests } from '../services/browser-tester.js';
import { runTaskTests } from '../services/task-tester.js';
import { runSSHTests } from '../services/ssh-tester.js';
import { runAPITests } from '../services/api-tester.js';
import { formatTestRunMarkdown, formatTestRunTelegram, suiteFromResults } from '../utils/report.js';
import { saveTestRunMemory, applyRLMLearning } from '../utils/memory.js';
import type { TelegramTopicsService } from '../../itachi-tasks/services/telegram-topics.js';

async function runSuiteWithCatch(
  name: string,
  fn: () => Promise<import('../types.js').TestResult[]>,
  logger: { warn: (msg: string) => void }
): Promise<TestSuite> {
  const start = Date.now();
  try {
    const results = await fn();
    const durationMs = Date.now() - start;
    return suiteFromResults(name, results, durationMs);
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.warn(`[itachi-tester] Suite "${name}" crashed: ${err instanceof Error ? err.message : String(err)}`);
    return suiteFromResults(name, [{
      name: 'suite-crash',
      status: 'error',
      durationMs,
      message: err instanceof Error ? err.message : String(err),
    }], durationMs);
  }
}

export const testRunnerWorker: TaskWorker = {
  name: 'ITACHI_TEST_RUNNER',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const enabled = runtime.getSetting('ITACHI_TESTER_ENABLED');
    if (enabled !== undefined && enabled !== null) {
      const str = String(enabled).trim().toLowerCase();
      if (str === 'false' || str === '0' || str === 'no') return false;
    }
    return true;
  },

  execute: async (runtime: IAgentRuntime, _options: unknown, _task: unknown): Promise<void> => {
    const logger = runtime.logger;
    logger.info('[itachi-tester] Starting E2E test run');

    const supabaseUrl = String(runtime.getSetting('SUPABASE_URL') || '');
    const supabaseKey = String(runtime.getSetting('SUPABASE_SERVICE_ROLE_KEY') || runtime.getSetting('SUPABASE_KEY') || '');

    if (!supabaseUrl || !supabaseKey) {
      logger.warn('[itachi-tester] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — aborting');
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Derive bot username
    let botUsername = String(runtime.getSetting('TELEGRAM_BOT_USERNAME') || '');
    if (!botUsername) {
      const token = String(runtime.getSetting('TELEGRAM_BOT_TOKEN') || '');
      if (token) {
        botUsername = token.split(':')[0] || 'itachi_bot';
      }
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const runStart = Date.now();

    // Run all suites independently
    const suites: TestSuite[] = await Promise.all([
      // Suite 1: Telegram UI (browser)
      runSuiteWithCatch('Telegram UI (browser)', () => runBrowserTests({ botUsername }), logger),
      // Suite 2: Task injection (sequential — uses Supabase polling)
      runSuiteWithCatch('Task Injection + Execution', () => runTaskTests(supabase), logger),
      // Suite 3: SSH connectivity
      runSuiteWithCatch('SSH Connectivity', () => runSSHTests(), logger),
      // Suite 4: API/Health
      runSuiteWithCatch('API / Health', () => runAPITests(), logger),
    ]);

    const durationMs = Date.now() - runStart;
    const completedAt = new Date().toISOString();

    const run: TestRun = {
      id: runId,
      startedAt,
      completedAt,
      suites,
      totalPass: suites.reduce((s, x) => s + x.passCount, 0),
      totalFail: suites.reduce((s, x) => s + x.failCount, 0),
      totalSkip: suites.reduce((s, x) => s + x.skipCount, 0),
      totalError: suites.reduce((s, x) => s + x.errorCount, 0),
      durationMs,
    };

    const markdownReport = formatTestRunMarkdown(run);
    const telegramReport = formatTestRunTelegram(run);

    logger.info(`[itachi-tester] Run complete — ${run.totalPass}✅ ${run.totalFail}❌ ${run.totalSkip}⏭ ${run.totalError}💥 in ${Math.round(durationMs / 1000)}s`);

    // Save to RLM memory
    try {
      await saveTestRunMemory(supabase, run, markdownReport);
      logger.info('[itachi-tester] Saved test run to itachi_memories');
    } catch (err) {
      logger.warn(`[itachi-tester] Failed to save memory: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Apply RLM learning (lessons + alerts)
    try {
      await applyRLMLearning(supabase, run, logger);
    } catch (err) {
      logger.warn(`[itachi-tester] RLM learning error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Report to Telegram
    try {
      const topicsService = runtime.getService<TelegramTopicsService>('telegram-topics');
      if (topicsService) {
        await topicsService.sendMessageWithKeyboard(telegramReport, []);
        logger.info('[itachi-tester] Reported to Telegram');
      } else {
        // Fallback: send via Telegram Bot API directly
        const botToken = String(runtime.getSetting('TELEGRAM_BOT_TOKEN') || '');
        const chatId = String(runtime.getSetting('TELEGRAM_CHAT_ID') || '');
        if (botToken && chatId) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: telegramReport,
              parse_mode: 'Markdown',
            }),
          });
          logger.info('[itachi-tester] Reported to Telegram via Bot API fallback');
        }
      }
    } catch (err) {
      logger.warn(`[itachi-tester] Failed to report to Telegram: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export async function registerTestRunnerTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_TEST_RUNNER');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_TEST_RUNNER task already exists, skipping');
      return;
    }
    await runtime.createTask({
      name: 'ITACHI_TEST_RUNNER',
      description: 'Persistent E2E testing with RLM learning (6h interval)',
      worldId: runtime.agentId,
      metadata: { updateInterval: 6 * 60 * 60 * 1000 },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_TEST_RUNNER repeating task (6h)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register test runner task:', error instanceof Error ? error.message : String(error));
  }
}
