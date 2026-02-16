import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import type { MemoryService, ItachiMemory } from '../../itachi-memory/services/memory-service.js';

/**
 * Weekly reflection worker: synthesizes individual lessons into strategy documents.
 * Reads task_lesson memories from itachi_memories (the same table where task-poller,
 * topic-input-relay, lesson-extractor, and /feedback store lessons).
 * Produces a strategy_document in itachi_memories.
 */
export const reflectionWorker: TaskWorker = {
  name: 'ITACHI_REFLECTION',

  validate: async (_runtime: IAgentRuntime, _task: unknown): Promise<boolean> => {
    return true; // Always valid when triggered by scheduler
  },

  execute: async (runtime: IAgentRuntime, _options: unknown, _task: unknown): Promise<void> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) {
        runtime.logger.warn('Reflection: MemoryService not available, skipping');
        return;
      }

      // 1. Query recent task_lesson memories
      let lessons: ItachiMemory[];
      try {
        lessons = await memoryService.searchMemories(
          'task lesson outcome success failure error budget',
          undefined,  // all projects
          50,
          undefined,
          'task_lesson',
        );
      } catch {
        runtime.logger.warn('Reflection: Failed to search for lessons');
        return;
      }

      if (lessons.length < 3) {
        runtime.logger.info(`Reflection: Not enough lessons to synthesize (found ${lessons.length}, need 3+)`);
        return;
      }

      // 2. Format lessons for synthesis
      const lessonText = lessons
        .map((l) => {
          const meta = (l.metadata || {}) as Record<string, unknown>;
          const category = meta.lesson_category || l.category || 'task_lesson';
          const confidence = meta.confidence ?? '';
          const outcome = meta.outcome ?? '';
          return `- [${category}] ${l.summary} (confidence: ${confidence}, outcome: ${outcome}, project: ${l.project})`;
        })
        .join('\n');

      // 3. Use LLM to synthesize into a strategy document
      const prompt = `You are Itachi, an AI project manager that learns from experience. Review these management lessons from recent tasks and synthesize them into updated strategies.

Lessons (${lessons.length} total):
${lessonText}

Create a concise strategy document with:
1. **Key Patterns**: What recurring themes do you see?
2. **Task Management**: How should you estimate budgets, select models, and handle timeouts?
3. **User Interaction**: What preferences and communication patterns work best?
4. **Error Recovery**: What failure modes are common and how to prevent them?
5. **Action Items**: What specific changes should you make to your behavior?

Keep it under 500 words. Be specific and actionable.`;

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        temperature: 0.5,
      });

      const strategy = typeof result === 'string' ? result : String(result);

      if (!strategy || strategy.length < 50) {
        runtime.logger.warn('Reflection: LLM produced insufficient strategy');
        return;
      }

      // 4. Check for existing strategy documents and clean up old ones (keep max 4)
      let existingStrategies: ItachiMemory[] = [];
      try {
        existingStrategies = await memoryService.searchMemories(
          'strategy document management',
          undefined,
          10,
          undefined,
          'strategy_document',
        );
      } catch {
        // Non-critical — if we can't find old ones, just store the new one
      }

      // Remove oldest if we have 4+
      if (existingStrategies.length >= 4) {
        const supabase = memoryService.getSupabase();
        const sorted = existingStrategies.sort((a, b) => {
          return (b.created_at || '').localeCompare(a.created_at || '');
        });
        for (const old of sorted.slice(3)) {
          try {
            await supabase.from('itachi_memories').delete().eq('id', old.id);
          } catch {
            // Silent — old doc cleanup is best-effort
          }
        }
      }

      // 5. Store new strategy document in itachi_memories
      await memoryService.storeMemory({
        project: 'general',
        category: 'strategy_document',
        content: strategy,
        summary: `Strategy document synthesized from ${lessons.length} lessons on ${new Date().toISOString().split('T')[0]}`,
        files: [],
        metadata: {
          source: 'reflection_worker',
          generated_at: new Date().toISOString(),
          lesson_count: lessons.length,
        },
      });

      runtime.logger.info(
        `Reflection complete: synthesized ${lessons.length} lessons into strategy document (stored in itachi_memories)`
      );
    } catch (error: unknown) {
      runtime.logger.error('Reflection worker error:', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Call this from the plugin init to register the repeating reflection task.
 */
export async function registerReflectionTask(runtime: IAgentRuntime): Promise<void> {
  try {
    // Check if already registered to avoid duplicates on restart
    const existing = await runtime.getTasksByName('ITACHI_REFLECTION');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_REFLECTION task already exists, skipping registration');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_REFLECTION',
      description: 'Weekly reflection that synthesizes lessons into strategy documents',
      worldId: runtime.agentId, // Use agent's default world for background tasks
      metadata: {
        updateInterval: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_REFLECTION repeating task (weekly)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register reflection task:', error instanceof Error ? error.message : String(error));
  }
}
