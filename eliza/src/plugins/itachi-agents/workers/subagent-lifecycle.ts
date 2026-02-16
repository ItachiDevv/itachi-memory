import type { TaskWorker, IAgentRuntime } from '@elizaos/core';
import { SubagentService } from '../services/subagent-service.js';
import { AgentCronService } from '../services/agent-cron-service.js';

/**
 * Subagent lifecycle worker (30s interval).
 * Handles: pending local runs, timeout detection, cleanup, cron job execution.
 */
export const subagentLifecycleWorker: TaskWorker = {
  name: 'ITACHI_SUBAGENT_LIFECYCLE',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return true;
  },

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const subagentService = runtime.getService('itachi-subagents') as SubagentService | undefined;
      if (!subagentService) return;

      // 1. Execute pending local runs
      const pendingLocal = await subagentService.getPendingLocalRuns();
      for (const run of pendingLocal) {
        runtime.logger.info(`[lifecycle] Executing pending local run ${run.id.slice(0, 8)} (${run.agent_profile_id})`);
        // Execute serially to avoid overwhelming the LLM
        await subagentService.executeLocal(run);
      }

      // 2. Cleanup expired/timed-out runs
      const cleaned = await subagentService.cleanupExpired();
      if (cleaned > 0) {
        runtime.logger.info(`[lifecycle] Cleaned up ${cleaned} expired run(s)`);
      }

      // 3. Process due cron jobs
      const cronService = runtime.getService('itachi-agent-cron') as AgentCronService | undefined;
      if (cronService) {
        const dueJobs = await cronService.getDueJobs();
        for (const job of dueJobs) {
          runtime.logger.info(`[lifecycle] Running cron job: ${job.task_description.slice(0, 50)}`);

          // Spawn a subagent for the cron job
          const run = await subagentService.spawn({
            profileId: job.agent_profile_id || 'devops',
            task: job.task_description,
            metadata: { cron_job_id: job.id },
          });

          if (run && run.execution_mode === 'local') {
            await subagentService.executeLocal(run);
          }

          // Update cron job timing
          await cronService.markRun(job.id, job.schedule);
        }
      }
    } catch (err) {
      runtime.logger.error('[lifecycle] Worker error:', err instanceof Error ? err.message : String(err));
    }
  },
};

export async function registerSubagentLifecycleTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_SUBAGENT_LIFECYCLE');
    if (existing && existing.length > 0) {
      runtime.logger.info('[lifecycle] Task already registered');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_SUBAGENT_LIFECYCLE',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 30_000,
      },
      tags: ['repeat'],
    });
    runtime.logger.info('[lifecycle] Registered repeating task (30s)');
  } catch (err) {
    runtime.logger.error('[lifecycle] Registration error:', err);
  }
}
