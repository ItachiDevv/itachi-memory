import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';

/**
 * Cleanup worker: runs monthly, archives old session_edits,
 * stale pattern observations, and low-confidence cross-project insights.
 * Calls the cleanup_intelligence_data() RPC.
 */
export const cleanupWorker: TaskWorker = {
  name: 'ITACHI_CLEANUP',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const codeIntel = runtime.getService<CodeIntelService>('itachi-code-intel');
      if (!codeIntel) {
        runtime.logger.warn('[cleanup] CodeIntelService not available');
        return;
      }

      await codeIntel.runCleanup();
      runtime.logger.info('[cleanup] Intelligence data cleanup completed');
    } catch (error) {
      runtime.logger.error('[cleanup] Error:', error);
    }
  },
};

export async function registerCleanupTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_CLEANUP');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_CLEANUP task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_CLEANUP',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 30 * 24 * 60 * 60 * 1000, // Monthly
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_CLEANUP repeating task (monthly)');
  } catch (error) {
    runtime.logger.error('Failed to register cleanup task:', error);
  }
}
