import { type TaskWorker, type IAgentRuntime, ModelType, MemoryType } from '@elizaos/core';

/**
 * Weekly reflection worker: synthesizes individual lessons into strategy documents.
 * Registered as a repeating task with 7-day interval.
 */
export const reflectionWorker: TaskWorker = {
  name: 'ITACHI_REFLECTION',

  validate: async (_runtime: IAgentRuntime, _task: unknown): Promise<boolean> => {
    return true; // Always valid when triggered by scheduler
  },

  execute: async (runtime: IAgentRuntime, _options: unknown, _task: unknown): Promise<void> => {
    try {
      // 1. Query all lessons from the last 7 days
      const recentLessons = await runtime.searchMemories({
        type: MemoryType.CUSTOM,
        query: 'management lesson task outcome',
        limit: 50,
        threshold: 0.3,
      });

      const lessons = recentLessons.filter(
        (m) => m.metadata?.type === 'management-lesson'
      );

      if (lessons.length < 3) {
        runtime.logger.info('Reflection: Not enough lessons to synthesize (need 3+)');
        return;
      }

      // 2. Format lessons for synthesis
      const lessonText = lessons
        .map((l) => {
          const meta = l.metadata || {};
          return `- [${meta.category}] ${l.content?.text} (confidence: ${meta.confidence}, outcome: ${meta.outcome})`;
        })
        .join('\n');

      // 3. Use LLM to synthesize into a strategy document
      const prompt = `You are Itachi, an AI project manager that learns from experience. Review these management lessons from the past week and synthesize them into updated strategies.

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

      // 4. Delete old strategy documents (keep max 4 — monthly rolling window)
      const existingStrategies = await runtime.searchMemories({
        type: MemoryType.CUSTOM,
        query: 'strategy document management',
        limit: 10,
        threshold: 0.3,
      });

      const stratDocs = existingStrategies
        .filter((m) => m.metadata?.type === 'strategy-document')
        .sort((a, b) => {
          const aDate = a.metadata?.generated_at || '';
          const bDate = b.metadata?.generated_at || '';
          return bDate.localeCompare(aDate);
        });

      // Remove oldest if we have 4+
      if (stratDocs.length >= 4) {
        for (const old of stratDocs.slice(3)) {
          try {
            await runtime.deleteMemory(old.id);
          } catch {
            // Silent — old doc cleanup is best-effort
          }
        }
      }

      // 5. Store new strategy document
      await runtime.createMemory({
        type: MemoryType.CUSTOM,
        content: { text: strategy },
        metadata: {
          type: 'strategy-document',
          generated_at: new Date().toISOString(),
          lesson_count: lessons.length,
        },
      });

      runtime.logger.info(
        `Reflection complete: synthesized ${lessons.length} lessons into strategy document`
      );
    } catch (error) {
      runtime.logger.error('Reflection worker error:', error);
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
      worldId: runtime.agentId, // Use agent's default world for background tasks
      metadata: {
        updateInterval: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_REFLECTION repeating task (weekly)');
  } catch (error) {
    runtime.logger.error('Failed to register reflection task:', error);
  }
}
