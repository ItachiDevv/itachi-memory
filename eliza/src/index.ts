import type { Project, ProjectAgent, IAgentRuntime } from '@elizaos/core';
import { character } from './character.js';
import { itachiMemoryPlugin, transcriptIndexerWorker, registerTranscriptIndexerTask } from './plugins/itachi-memory/index.js';
import { itachiTasksPlugin, githubRepoSyncWorker, registerGithubRepoSyncTask, healthMonitorWorker, registerHealthMonitorTask } from './plugins/itachi-tasks/index.js';
import { itachiSelfImprovePlugin, reflectionWorker, registerReflectionTask, effectivenessWorker, registerEffectivenessTask } from './plugins/itachi-self-improve/index.js';
import { itachiCodexPlugin } from './plugins/plugin-codex/index.js';
import { itachiGeminiPlugin } from './plugins/plugin-gemini/index.js';

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
    itachiSelfImprovePlugin,
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
      { worker: githubRepoSyncWorker, register: registerGithubRepoSyncTask, name: 'github-repo-sync' },
      { worker: healthMonitorWorker, register: registerHealthMonitorTask, name: 'health-monitor' },
      { worker: effectivenessWorker, register: registerEffectivenessTask, name: 'effectiveness' },
      { worker: transcriptIndexerWorker, register: registerTranscriptIndexerTask, name: 'transcript-indexer' },
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
      // Critical: GitHub repo sync (24h, first run after 30s)
      { name: 'github-sync', intervalMs: 86_400_000, delayMs: 30_000,
        validate: (rt) => githubRepoSyncWorker.validate!(rt, {} as any, {} as any),
        execute: (rt) => githubRepoSyncWorker.execute(rt, {}, { name: 'ITACHI_GITHUB_REPO_SYNC', tags: [], description: '' }) },
      // Self-improve: reflection (weekly, start after 6m)
      { name: 'reflection', intervalMs: 604_800_000, delayMs: 360_000,
        execute: (rt) => reflectionWorker.execute(rt, {}, { name: 'ITACHI_REFLECTION', tags: [], description: '' }) },
      // Health monitor (60s, start after 25s)
      { name: 'health-monitor', intervalMs: 60_000, delayMs: 25_000,
        execute: (rt) => healthMonitorWorker.execute(rt, {}, { name: 'ITACHI_HEALTH_MONITOR', tags: [], description: '' }) },
      // Self-improve: effectiveness review (weekly, start after 7m)
      { name: 'effectiveness', intervalMs: 604_800_000, delayMs: 420_000,
        execute: (rt) => effectivenessWorker.execute(rt, {}, { name: 'ITACHI_EFFECTIVENESS', tags: [], description: '' }) },
      // Memory: transcript indexer (1hr, start after 90s)
      { name: 'transcript-indexer', intervalMs: 3_600_000, delayMs: 90_000,
        validate: (rt) => transcriptIndexerWorker.validate!(rt, {} as any, {} as any),
        execute: (rt) => transcriptIndexerWorker.execute(rt, {}, { name: 'ITACHI_TRANSCRIPT_INDEXER', tags: [], description: '' }) },
    ]);
  },
};

const project: Project = {
  agents: [agent],
};

export default project;
