import type { Project, ProjectAgent, IAgentRuntime } from '@elizaos/core';
import { character } from './character.js';
import { itachiMemoryPlugin } from './plugins/itachi-memory/index.js';
import { itachiTasksPlugin, taskDispatcherWorker, registerTaskDispatcherTask, githubRepoSyncWorker, registerGithubRepoSyncTask, reminderPollerWorker, registerReminderPollerTask, proactiveMonitorWorker, registerProactiveMonitorTask, healthMonitorWorker, registerHealthMonitorTask, brainLoopWorker, registerBrainLoopTask } from './plugins/itachi-tasks/index.js';
import { itachiSyncPlugin } from './plugins/itachi-sync/index.js';
import { itachiSelfImprovePlugin, reflectionWorker, registerReflectionTask } from './plugins/itachi-self-improve/index.js';
import { itachiCodexPlugin } from './plugins/plugin-codex/index.js';
import { itachiGeminiPlugin } from './plugins/plugin-gemini/index.js';
import {
  itachiCodeIntelPlugin,
  editAnalyzerWorker, registerEditAnalyzerTask,
  sessionSynthesizerWorker, registerSessionSynthesizerTask,
  repoExpertiseWorker, registerRepoExpertiseTask,
  styleExtractorWorker, registerStyleExtractorTask,
  crossProjectWorker, registerCrossProjectTask,
  cleanupWorker, registerCleanupTask,
} from './plugins/itachi-code-intel/index.js';
import { itachiAgentsPlugin, subagentLifecycleWorker, registerSubagentLifecycleTask } from './plugins/itachi-agents/index.js';

/**
 * ElizaOS TaskWorker scheduler is non-functional (tasks never execute).
 * Use setInterval as a reliable alternative.
 */
interface WorkerDef {
  name: string;
  intervalMs: number;
  delayMs: number;
  validate?: (runtime: IAgentRuntime) => Promise<boolean>;
  execute: (runtime: IAgentRuntime) => Promise<void>;
}

let intervalSchedulerStarted = false;

function resolveBoolSetting(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function scheduleWorkers(runtime: IAgentRuntime, workers: WorkerDef[]): void {
  for (const w of workers) {
    const run = async () => {
      try {
        if (w.validate) {
          const valid = await w.validate(runtime);
          if (!valid) return;
        }
        await w.execute(runtime);
      } catch (err) {
        runtime.logger.warn(`[scheduler] ${w.name} error:`, err instanceof Error ? err.message : String(err));
      }
    };
    setTimeout(run, w.delayMs);
    setInterval(run, w.intervalMs);
    runtime.logger.info(`[scheduler] ${w.name}: ${w.intervalMs < 60_000 ? `${w.intervalMs / 1000}s` : w.intervalMs < 3_600_000 ? `${w.intervalMs / 60_000}m` : `${w.intervalMs / 3_600_000}h`} interval`);
  }
}

const agent: ProjectAgent = {
  character,
  plugins: [
    itachiCodexPlugin,
    itachiGeminiPlugin,
    itachiMemoryPlugin,
    itachiTasksPlugin,
    itachiSyncPlugin,
    itachiSelfImprovePlugin,
    itachiCodeIntelPlugin,
    itachiAgentsPlugin,
  ],
  init: async (runtime) => {
    runtime.logger.info('Itachi agent initialized');
    runtime.logger.info(`Supabase URL: ${runtime.getSetting('SUPABASE_URL') ? 'configured' : 'MISSING'}`);
    runtime.logger.info(`Telegram: ${runtime.getSetting('TELEGRAM_BOT_TOKEN') ? 'configured' : 'MISSING'}`);
    const useNativeTaskworker = resolveBoolSetting(
      runtime.getSetting('ITACHI_USE_NATIVE_TASKWORKER') ?? process.env.ITACHI_USE_NATIVE_TASKWORKER,
      false
    );

    // Register workers with ElizaOS TaskWorker system (backup, currently non-functional)
    const allWorkers = [
      { worker: reflectionWorker, register: registerReflectionTask, name: 'reflection' },
      { worker: editAnalyzerWorker, register: registerEditAnalyzerTask, name: 'edit-analyzer' },
      { worker: sessionSynthesizerWorker, register: registerSessionSynthesizerTask, name: 'session-synthesizer' },
      { worker: repoExpertiseWorker, register: registerRepoExpertiseTask, name: 'repo-expertise' },
      { worker: styleExtractorWorker, register: registerStyleExtractorTask, name: 'style-extractor' },
      { worker: crossProjectWorker, register: registerCrossProjectTask, name: 'cross-project' },
      { worker: cleanupWorker, register: registerCleanupTask, name: 'cleanup' },
      { worker: taskDispatcherWorker, register: registerTaskDispatcherTask, name: 'task-dispatcher' },
      { worker: githubRepoSyncWorker, register: registerGithubRepoSyncTask, name: 'github-repo-sync' },
      { worker: reminderPollerWorker, register: registerReminderPollerTask, name: 'reminder-poller' },
      { worker: proactiveMonitorWorker, register: registerProactiveMonitorTask, name: 'proactive-monitor' },
      { worker: healthMonitorWorker, register: registerHealthMonitorTask, name: 'health-monitor' },
      { worker: brainLoopWorker, register: registerBrainLoopTask, name: 'brain-loop' },
      { worker: subagentLifecycleWorker, register: registerSubagentLifecycleTask, name: 'subagent-lifecycle' },
    ];

    for (const { worker, register, name } of allWorkers) {
      try {
        runtime.registerTaskWorker(worker);
        await register(runtime);
      } catch (err: unknown) {
        runtime.logger.warn(`Failed to register ${name} worker (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }
    runtime.logger.info(`Registered ${allWorkers.length} TaskWorkers with ElizaOS`);

    // Schedule workers via setInterval (reliable execution fallback)
    if (useNativeTaskworker) {
      runtime.logger.info('[scheduler] ITACHI_USE_NATIVE_TASKWORKER=true, skipping interval fallback scheduler');
      return;
    }
    if (intervalSchedulerStarted) {
      runtime.logger.warn('[scheduler] Interval scheduler already started, skipping duplicate init');
      return;
    }
    intervalSchedulerStarted = true;
    scheduleWorkers(runtime, [
      // Critical: task dispatch (10s, start after 10s)
      { name: 'task-dispatcher', intervalMs: 10_000, delayMs: 10_000,
        execute: (rt) => taskDispatcherWorker.execute(rt, {}, { name: 'ITACHI_TASK_DISPATCHER', tags: [], description: '' }) },
      // Critical: GitHub repo sync (24h, first run after 30s)
      { name: 'github-sync', intervalMs: 86_400_000, delayMs: 30_000,
        validate: (rt) => githubRepoSyncWorker.validate!(rt, {} as any, {} as any),
        execute: (rt) => githubRepoSyncWorker.execute(rt, {}, { name: 'ITACHI_GITHUB_REPO_SYNC', tags: [], description: '' }) },
      // Code-intel: edit analyzer (15m, start after 60s)
      { name: 'edit-analyzer', intervalMs: 900_000, delayMs: 60_000,
        execute: (rt) => editAnalyzerWorker.execute(rt, {}, { name: 'ITACHI_EDIT_ANALYZER', tags: [], description: '' }) },
      // Code-intel: session synthesizer (30m, start after 45s)
      { name: 'session-synthesizer', intervalMs: 1_800_000, delayMs: 45_000,
        execute: (rt) => sessionSynthesizerWorker.execute(rt, {}, { name: 'ITACHI_SESSION_SYNTHESIZER', tags: [], description: '' }) },
      // Code-intel: repo expertise (24h, start after 2m)
      { name: 'repo-expertise', intervalMs: 86_400_000, delayMs: 120_000,
        execute: (rt) => repoExpertiseWorker.execute(rt, {}, { name: 'ITACHI_REPO_EXPERTISE', tags: [], description: '' }) },
      // Code-intel: style extractor (weekly, start after 3m)
      { name: 'style-extractor', intervalMs: 604_800_000, delayMs: 180_000,
        execute: (rt) => styleExtractorWorker.execute(rt, {}, { name: 'ITACHI_STYLE_EXTRACTOR', tags: [], description: '' }) },
      // Code-intel: cross-project (weekly, start after 4m)
      { name: 'cross-project', intervalMs: 604_800_000, delayMs: 240_000,
        execute: (rt) => crossProjectWorker.execute(rt, {}, { name: 'ITACHI_CROSS_PROJECT', tags: [], description: '' }) },
      // Code-intel: cleanup (weekly, start after 5m) — capped to fit 32-bit signed int
      { name: 'cleanup', intervalMs: 604_800_000, delayMs: 300_000,
        execute: (rt) => cleanupWorker.execute(rt, {}, { name: 'ITACHI_CLEANUP', tags: [], description: '' }) },
      // Self-improve: reflection (weekly, start after 6m)
      { name: 'reflection', intervalMs: 604_800_000, delayMs: 360_000,
        execute: (rt) => reflectionWorker.execute(rt, {}, { name: 'ITACHI_REFLECTION', tags: [], description: '' }) },
      // Reminders: check for due reminders (60s, start after 15s)
      { name: 'reminder-poller', intervalMs: 60_000, delayMs: 15_000,
        validate: (rt) => reminderPollerWorker.validate!(rt, {} as any, {} as any),
        execute: (rt) => reminderPollerWorker.execute(rt, {}, { name: 'ITACHI_REMINDER_POLLER', tags: [], description: '' }) },
      // Agents: subagent lifecycle (30s, start after 20s)
      { name: 'subagent-lifecycle', intervalMs: 30_000, delayMs: 20_000,
        execute: (rt) => subagentLifecycleWorker.execute(rt, {}, { name: 'ITACHI_SUBAGENT_LIFECYCLE', tags: [], description: '' }) },
      // Health monitor (60s, start after 25s)
      { name: 'health-monitor', intervalMs: 60_000, delayMs: 25_000,
        execute: (rt) => healthMonitorWorker.execute(rt, {}, { name: 'ITACHI_HEALTH_MONITOR', tags: [], description: '' }) },
      // Brain loop (10min, start after 2min)
      { name: 'brain-loop', intervalMs: 600_000, delayMs: 120_000,
        validate: (rt) => brainLoopWorker.validate!(rt, {} as any, {} as any),
        execute: (rt) => brainLoopWorker.execute(rt, {}, { name: 'ITACHI_BRAIN_LOOP', tags: [], description: '' }) },
    ]);
  },
};

const project: Project = {
  agents: [agent],
};

export default project;
