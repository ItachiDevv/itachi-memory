import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';

/**
 * Cleanup worker: runs monthly, archives old session_edits,
 * stale pattern observations, and low-confidence cross-project insights.
 * Calls the cleanup_intelligence_data() RPC.
 */
let lastCleanupRun = 0;
const CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // Weekly (must fit 32-bit signed int for setInterval)

export const cleanupWorker: TaskWorker = {
  name: 'ITACHI_CLEANUP',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return Date.now() - lastCleanupRun >= CLEANUP_INTERVAL_MS;
  },

  execute: async (runtime: IAgentRuntime, _options: { [key: string]: unknown }, _task: unknown): Promise<void> => {
    // Set timestamp BEFORE async work to prevent concurrent burst executions
    lastCleanupRun = Date.now();
    try {
      const codeIntel = runtime.getService('itachi-code-intel') as CodeIntelService | null;
      if (!codeIntel) {
        runtime.logger.warn('[cleanup] CodeIntelService not available');
        return;
      }

      await codeIntel.runCleanup();
      runtime.logger.info('[cleanup] Intelligence data cleanup completed');
    } catch (error: unknown) {
      runtime.logger.error('[cleanup] Error:', error instanceof Error ? error.message : String(error));
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
      description: 'Monthly cleanup of old intelligence data',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 30 * 24 * 60 * 60 * 1000, // Monthly
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_CLEANUP repeating task (monthly)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register cleanup task:', error instanceof Error ? error.message : String(error));
  }
}
