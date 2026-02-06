import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType, MemoryType } from '@elizaos/core';

interface ExtractedLesson {
  text: string;
  category: string;
  confidence: number;
  taskId?: string;
  outcome: 'success' | 'failure' | 'partial';
}

export const lessonExtractor: Evaluator = {
  name: 'LESSON_EXTRACTOR',
  description: 'Extract management lessons from task completions and user feedback',
  similes: ['learn from outcomes', 'extract insights'],
  alwaysRun: false,

  examples: [
    {
      prompt: 'Task a1b2c3d4 completed! Result: Fixed login bug. PR: github.com/...',
      response: 'Extracted lesson: Tasks in auth-related code benefit from targeted test runs before PR creation.',
    },
    {
      prompt: 'That was wrong, the budget was too low for that refactoring task',
      response: 'Extracted lesson: Refactoring tasks need higher budgets ($8+) to complete properly.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';

    // Run when a task completed/failed (check recent action results)
    const hasTaskResult = Array.isArray(state?.data?.actionResults) &&
      state.data.actionResults.some(
        (r: Record<string, unknown>) =>
          r.data && typeof r.data === 'object' && 'taskId' in (r.data as Record<string, unknown>)
      );

    // Run when user gives feedback
    const hasFeedback = /\b(good|bad|wrong|right|better|worse|mistake|perfect|great|terrible|nice|failed)\b/.test(text);

    // Run when a task completion notification is in the message
    const hasCompletion = text.includes('completed') || text.includes('failed') || text.includes('timeout');

    return hasTaskResult || hasFeedback || hasCompletion;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<{ lessons: ExtractedLesson[] }> => {
    try {
      const recentMessages = state?.data?.recentMessages || [];
      const recentContext = Array.isArray(recentMessages)
        ? recentMessages
            .slice(-6)
            .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
            .join('\n')
        : '';

      const currentMessage = message.content?.text || '';

      const prompt = `You are analyzing a conversation between a user and Itachi (an AI project manager) to extract management lessons.

Recent conversation:
${recentContext}

Current message:
${currentMessage}

Extract actionable management lessons from this interaction. Focus on:
- task-estimation: Was the budget/model/time appropriate?
- project-selection: Was the right project identified?
- error-handling: What went wrong and how was it handled?
- user-preference: How does the user prefer things done?
- tool-selection: Which approach worked best?

Return a JSON array of lessons. Each lesson must have:
- "text": concise lesson statement (1-2 sentences)
- "category": one of the categories above
- "confidence": 0.0-1.0 how confident this lesson is
- "outcome": "success" | "failure" | "partial"

If no meaningful lessons can be extracted, return an empty array.
Respond ONLY with valid JSON array, no markdown fences.`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.3,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let lessons: ExtractedLesson[];
      try {
        lessons = JSON.parse(raw.trim());
      } catch {
        runtime.logger.warn('Lesson extractor: unparseable LLM output');
        return { lessons: [] };
      }

      if (!Array.isArray(lessons)) return { lessons: [] };

      // Validate and store each lesson
      const stored: ExtractedLesson[] = [];
      for (const lesson of lessons) {
        if (!lesson.text || !lesson.category || typeof lesson.confidence !== 'number') continue;
        if (lesson.confidence < 0.5) continue; // Skip low-confidence lessons

        try {
          await runtime.createMemory({
            type: MemoryType.CUSTOM,
            content: { text: lesson.text },
            metadata: {
              type: 'management-lesson',
              category: lesson.category,
              confidence: lesson.confidence,
              outcome: lesson.outcome || 'partial',
              extracted_at: new Date().toISOString(),
            },
            roomId: message.roomId,
            entityId: message.entityId,
          });
          stored.push(lesson);
        } catch (err) {
          runtime.logger.error('Failed to store lesson:', err);
        }
      }

      if (stored.length > 0) {
        runtime.logger.info(`Extracted ${stored.length} management lessons`);
      }

      return { lessons: stored };
    } catch (error) {
      runtime.logger.error('Lesson extractor error:', error);
      return { lessons: [] };
    }
  },
};
