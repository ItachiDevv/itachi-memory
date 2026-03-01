import type { Evaluator, IAgentRuntime, Memory, State } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { SubagentService } from '../services/subagent-service.js';
import { AgentProfileService } from '../services/agent-profile-service.js';

/**
 * Extracts lessons from completed subagent runs and stores them
 * under the profile's memory namespace for future spawns.
 */
export const subagentLessonEvaluator: Evaluator = {
  name: 'SUBAGENT_LESSON',
  description: 'Extract per-profile lessons from completed subagent runs',
  similes: ['learn from agent', 'agent lesson'],
  alwaysRun: true,

  examples: [
    {
      prompt: 'Evaluates completed subagent runs for extractable lessons',
      messages: [
        { name: 'user', content: { text: 'show me the code review results' } },
      ],
      outcome: 'Extracts lessons from recently completed code-reviewer runs',
    },
  ],

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    // Cheap check: only run if subagent service exists
    const service = runtime.getService('itachi-subagents') as SubagentService | undefined;
    return !!service;
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<{ result?: unknown }> => {
    try {
      const subagentService = runtime.getService('itachi-subagents') as SubagentService | undefined;
      const profileService = runtime.getService('itachi-agent-profiles') as AgentProfileService | undefined;
      if (!subagentService || !profileService) return {};

      // Find recently completed runs that haven't had lessons extracted
      const recent = await subagentService.getRecentRuns(10);
      const completed = recent.filter(
        (r) => r.status === 'completed' && r.result && !(r.metadata as any)?.lesson_extracted,
      );

      if (completed.length === 0) return {};

      let extractedCount = 0;
      for (const run of completed.slice(0, 3)) {
        // Only extract lessons from runs with meaningful results
        if (!run.result || run.result.length < 50) continue;

        try {
          const lesson = await extractLesson(runtime, run.task, run.result);
          if (lesson) {
            await profileService.storeLessonViaMemoryService(runtime, run.agent_profile_id, lesson);

            // Cross-agent sharing: store in shared task_lesson pool
            try {
              const memoryService = runtime.getService('itachi-memory') as any;
              if (memoryService?.storeMemory) {
                await memoryService.storeMemory({
                  project: 'general',
                  category: 'task_lesson',
                  content: `[Subagent: ${run.agent_profile_id}] ${lesson}`,
                  summary: lesson,
                  files: [],
                  metadata: {
                    source: 'subagent',
                    source_agent: run.agent_profile_id,
                    confidence: 0.7,
                    outcome: 'success',
                  },
                });
              }
            } catch (err) {
              runtime.logger.warn(`[subagent-lesson] cross-agent lesson share failed: ${err instanceof Error ? err.message : String(err)}`);
            }

            extractedCount++;
          }

          // Mark as processed
          const supabase = profileService.getSupabase();
          await supabase
            .from('itachi_subagent_runs')
            .update({
              metadata: { ...(run.metadata || {}), lesson_extracted: true },
            })
            .eq('id', run.id);
        } catch (err) {
          runtime.logger.warn('[subagent-lesson] Error extracting lesson:', err);
        }
      }

      if (extractedCount > 0) {
        runtime.logger.info(`[subagent-lesson] Extracted ${extractedCount} lesson(s)`);
      }
      return { result: { extracted: extractedCount } };
    } catch (err) {
      runtime.logger.error('[subagent-lesson] Error:', err);
      return {};
    }
  },
};

async function extractLesson(runtime: IAgentRuntime, task: string, result: string): Promise<string | null> {
  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Given this subagent task and result, extract a concise lesson learned that would help future tasks of this type. If there's no meaningful lesson, respond with "NONE".

Task: ${task.slice(0, 500)}

Result: ${result.slice(0, 1000)}

Lesson (1-2 sentences):`,
      temperature: 0.2,
    });

    const text = (typeof response === 'string' ? response : '').trim();
    if (!text || text === 'NONE' || text.length < 10) return null;
    return text;
  } catch {
    return null;
  }
}
