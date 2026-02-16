import { type Evaluator, type IAgentRuntime, type Memory, type State, ModelType } from '@elizaos/core';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

interface ExtractedLesson {
  text: string;
  category: string;
  confidence: number;
  taskId?: string;
  project?: string;
  outcome: 'success' | 'failure' | 'partial';
}

export const lessonExtractor: Evaluator = {
  name: 'LESSON_EXTRACTOR',
  description: 'Extract management lessons from task completions and user feedback',
  similes: ['learn from outcomes', 'extract insights'],
  alwaysRun: false,

  examples: [
    {
      prompt: 'Evaluate whether a lesson can be extracted from this task completion.',
      messages: [
        { name: '{{name1}}', content: { text: 'Task a1b2c3d4 completed! Result: Fixed login bug. PR: github.com/...' } },
        { name: 'Itachi', content: { text: 'Great, the auth fix is merged.' } },
      ],
      outcome: 'Extracted lesson: Tasks in auth-related code benefit from targeted test runs before PR creation.',
    },
    {
      prompt: 'Evaluate whether a lesson can be extracted from this feedback.',
      messages: [
        { name: '{{name1}}', content: { text: 'That was wrong, the budget was too low for that refactoring task' } },
        { name: 'Itachi', content: { text: 'Noted, I\'ll increase the budget next time.' } },
      ],
      outcome: 'Extracted lesson: Refactoring tasks need higher budgets ($8+) to complete properly.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';

    // Run when a task completed/failed (check recent action results)
    const hasTaskResult = Array.isArray(state?.data?.actionResults) &&
      (state.data.actionResults as unknown as Array<Record<string, unknown>>).some(
        (r: Record<string, unknown>) =>
          r.data && typeof r.data === 'object' && 'taskId' in (r.data as Record<string, unknown>)
      );

    // Run when user gives feedback
    const hasFeedback = /\b(good|bad|wrong|right|better|worse|mistake|perfect|great|terrible|nice|failed)\b/.test(text);

    // Run when a task completion notification is in the message
    const hasCompletion = text.includes('completed') || text.includes('failed') || text.includes('timeout');

    return hasTaskResult || hasFeedback || hasCompletion;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<void> => {
    try {
      // Use MemoryService (itachi_memories table) so lessons are visible to
      // enrichWithLessons(), /recall, lessonsProvider, and reflection worker.
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) {
        runtime.logger.warn('LESSON_EXTRACTOR: MemoryService not available, skipping');
        return;
      }

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
- "project": project name if identifiable, or "general"

If no meaningful lessons can be extracted, return an empty array.
Respond ONLY with valid JSON array, no markdown fences.`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.3,
      });

      const raw = typeof result === 'string' ? result : String(result);
      let lessons: ExtractedLesson[];
      try {
        // Strip markdown fences if present
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        lessons = JSON.parse(cleaned);
      } catch {
        runtime.logger.warn('Lesson extractor: unparseable LLM output');
        return;
      }

      if (!Array.isArray(lessons)) return;

      // Validate and store each lesson via MemoryService (itachi_memories)
      let storedCount = 0;
      for (const lesson of lessons) {
        if (!lesson.text || !lesson.category || typeof lesson.confidence !== 'number') continue;
        if (lesson.confidence < 0.5) continue; // Skip low-confidence lessons

        try {
          await memoryService.storeMemory({
            project: lesson.project || 'general',
            category: 'task_lesson',
            content: `Lesson: ${lesson.text}\nCategory: ${lesson.category}\nOutcome: ${lesson.outcome || 'partial'}`,
            summary: lesson.text,
            files: [],
            metadata: {
              source: 'lesson_extractor',
              lesson_category: lesson.category,
              confidence: lesson.confidence,
              outcome: lesson.outcome || 'partial',
              extracted_at: new Date().toISOString(),
            },
          });
          storedCount++;
        } catch (err: unknown) {
          runtime.logger.error('Failed to store lesson:', err instanceof Error ? err.message : String(err));
        }
      }

      if (storedCount > 0) {
        runtime.logger.info(`LESSON_EXTRACTOR: stored ${storedCount} management lessons in itachi_memories`);
      }
    } catch (error: unknown) {
      runtime.logger.error('Lesson extractor error:', error instanceof Error ? error.message : String(error));
    }
  },
};
