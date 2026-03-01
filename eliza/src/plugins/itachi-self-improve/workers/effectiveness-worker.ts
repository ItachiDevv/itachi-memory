import { type TaskWorker, type IAgentRuntime } from '@elizaos/core';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

export const effectivenessWorker: TaskWorker = {
  name: 'ITACHI_EFFECTIVENESS',

  validate: async (_runtime: IAgentRuntime, _task: unknown): Promise<boolean> => {
    return true;
  },

  execute: async (runtime: IAgentRuntime, _options: unknown, _task: unknown): Promise<void> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return;

      const supabase = memoryService.getSupabase();

      // Fetch all task_lesson memories with metadata
      const { data: lessons, error } = await supabase
        .from('itachi_memories')
        .select('id, summary, metadata, created_at')
        .eq('category', 'task_lesson')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error || !lessons) {
        runtime.logger.warn('[effectiveness] Failed to query lessons:', error?.message);
        return;
      }

      let boosted = 0;
      let decayed = 0;

      for (const lesson of lessons) {
        const meta = (lesson.metadata || {}) as Record<string, unknown>;
        const timesReinforced = typeof meta.times_reinforced === 'number' ? meta.times_reinforced : 0;
        const confidence = typeof meta.confidence === 'number' ? meta.confidence : 0.5;
        const lastOutcome = meta.last_outcome as string | undefined;

        // Only evaluate lessons that have been applied enough times
        if (timesReinforced < 5) continue;

        // Check success/failure pattern from metadata
        const successCount = typeof meta.success_count === 'number' ? meta.success_count : 0;
        const failureCount = typeof meta.failure_count === 'number' ? meta.failure_count : 0;
        const totalApplications = successCount + failureCount;

        if (totalApplications < 5) {
          // Approximate from reinforcement patterns
          if (lastOutcome === 'success' && confidence > 0.7) continue; // Likely fine
          if (lastOutcome === 'failure' && confidence < 0.3) continue; // Already decayed
        }

        const successRate = totalApplications > 0 ? successCount / totalApplications : 0.5;

        let newConfidence = confidence;
        if (totalApplications >= 5 && successRate < 0.3) {
          newConfidence = 0.1;
          decayed++;
        } else if (totalApplications >= 5 && successRate > 0.8) {
          newConfidence = 0.95;
          boosted++;
        }

        if (newConfidence !== confidence) {
          try {
            await supabase
              .from('itachi_memories')
              .update({
                metadata: {
                  ...meta,
                  confidence: newConfidence,
                  effectiveness_reviewed: new Date().toISOString(),
                },
              })
              .eq('id', lesson.id);
          } catch (err) {
            runtime.logger.warn(`[effectiveness] confidence update failed for ${lesson.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      runtime.logger.info(
        `[effectiveness] Reviewed ${lessons.length} lessons: ${boosted} boosted, ${decayed} decayed`
      );
    } catch (error: unknown) {
      runtime.logger.error('Effectiveness worker error:', error instanceof Error ? error.message : String(error));
    }
  },
};

export async function registerEffectivenessTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_EFFECTIVENESS');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_EFFECTIVENESS task already exists, skipping');
      return;
    }
    await runtime.createTask({
      name: 'ITACHI_EFFECTIVENESS',
      description: 'Weekly effectiveness review of lesson confidence',
      worldId: runtime.agentId,
      metadata: { updateInterval: 7 * 24 * 60 * 60 * 1000 },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_EFFECTIVENESS repeating task (weekly)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register effectiveness task:', error instanceof Error ? error.message : String(error));
  }
}
