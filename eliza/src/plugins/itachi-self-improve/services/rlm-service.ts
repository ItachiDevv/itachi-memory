import { Service, type IAgentRuntime } from '@elizaos/core';
import type { MemoryService, ItachiMemory } from '../../itachi-memory/services/memory-service.js';

export interface RLMRecommendations {
  suggestedBudget?: number;
  suggestedModel?: string;
  warnings: string[];
}

export class RLMService extends Service {
  static serviceType = 'rlm';
  capabilityDescription = 'Reinforcement Learning from Memory — tracks outcomes and provides recommendations';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<RLMService> {
    const service = new RLMService(runtime);
    runtime.logger.info('RLMService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('RLMService stopped');
  }

  /** Record a task outcome for future learning */
  async recordOutcome(
    taskId: string,
    outcome: 'success' | 'failure' | 'partial',
    score: number,
    project?: string
  ): Promise<void> {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return;

    try {
      await memoryService.storeMemory({
        project: project || 'general',
        category: 'lesson_application',
        content: `Task ${taskId} outcome: ${outcome} (score: ${score})`,
        summary: `Task outcome: ${outcome} (score: ${score.toFixed(2)})`,
        files: [],
        task_id: taskId,
        metadata: {
          outcome,
          score,
          source: 'rlm_service',
          recorded_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      this.runtime.logger.warn(`[rlm] Failed to record outcome: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Reinforce lessons that were in context for a completed task */
  async reinforceLessonsForTask(
    taskId: string,
    taskDescription: string,
    project: string,
    succeeded: boolean
  ): Promise<number> {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return 0;

    try {
      const contextLessons = await memoryService.searchMemories(
        taskDescription.substring(0, 200),
        project,
        5,
        undefined,
        'task_lesson',
      );

      let reinforced = 0;
      for (const lesson of contextLessons) {
        const currentConf = (lesson.metadata as Record<string, unknown>)?.confidence;
        const confNum = typeof currentConf === 'number' ? currentConf : 0.5;
        try {
          if (succeeded) {
            await memoryService.reinforceMemory(lesson.id, {
              confidence: Math.min(confNum + 0.05, 0.99),
              last_outcome: 'success',
            });
          } else {
            await memoryService.reinforceMemory(lesson.id, {
              confidence: Math.max(confNum * 0.85, 0.1),
              last_outcome: 'failure',
            });
          }
          reinforced++;
        } catch (err) {
          this.runtime.logger.warn(`[rlm] reinforce lesson ${lesson.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return reinforced;
    } catch (err) {
      this.runtime.logger.warn(`[rlm] reinforceLessonsForTask error: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** Reinforce lessons based on per-segment outcomes from a session */
  async reinforceLessonsForSegments(
    segments: Array<{ task: string; outcome: string; approach?: string; error?: string }>,
    project: string
  ): Promise<{ reinforced: number; recorded: number }> {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return { reinforced: 0, recorded: 0 };

    let reinforced = 0;
    let recorded = 0;

    for (const seg of segments.slice(0, 15)) {
      if (!seg.task || seg.task.length < 5) continue;
      const succeeded = seg.outcome === 'success';
      const failed = seg.outcome === 'failure';

      try {
        // Find lessons related to this segment's task
        const related = await memoryService.searchMemories(
          seg.task.substring(0, 200),
          project,
          3,
          undefined,
          'task_lesson',
        );

        for (const lesson of related) {
          if ((lesson.similarity ?? 0) < 0.6) continue;
          const meta = (lesson.metadata || {}) as Record<string, unknown>;
          const confNum = typeof meta.confidence === 'number' ? meta.confidence : 0.5;
          try {
            if (succeeded) {
              await memoryService.reinforceMemory(lesson.id, {
                confidence: Math.min(confNum + 0.03, 0.99),
                last_outcome: 'success',
                last_segment: seg.task.substring(0, 100),
              });
            } else if (failed) {
              await memoryService.reinforceMemory(lesson.id, {
                confidence: Math.max(confNum * 0.9, 0.1),
                last_outcome: 'failure',
                last_segment: seg.task.substring(0, 100),
              });
            }
            reinforced++;
          } catch (err) {
            this.runtime.logger.warn(`[rlm] reinforce segment lesson failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Also reinforce related task_segment memories (proven/disproven patterns)
        const relatedSegments = await memoryService.searchMemories(
          seg.task.substring(0, 200),
          project,
          2,
          undefined,
          'task_segment',
        );

        for (const prev of relatedSegments) {
          if ((prev.similarity ?? 0) < 0.7) continue;
          const prevOutcome = (prev.metadata as Record<string, unknown>)?.outcome;
          // If same approach led to same outcome again, reinforce
          if (prevOutcome === seg.outcome) {
            try {
              await memoryService.reinforceMemory(prev.id, {
                last_outcome: seg.outcome,
                pattern_confirmed: true,
              });
              reinforced++;
            } catch (err) {
              this.runtime.logger.warn(`[rlm] reinforce segment pattern failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        recorded++;
      } catch (err) {
        this.runtime.logger.warn(
          `[rlm] reinforceLessonsForSegments error for "${seg.task.substring(0, 40)}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { reinforced, recorded };
  }

  /** Get recommendations based on past task outcomes */
  async getRecommendations(project: string, description: string): Promise<RLMRecommendations> {
    const warnings: string[] = [];
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return { warnings };

    try {
      // Search for lessons related to this type of task
      const relatedLessons = await memoryService.searchMemories(
        description.substring(0, 200),
        project,
        8,
        undefined,
        'task_lesson',
      );

      // Check for failure patterns
      const failureLessons = relatedLessons.filter((l) => {
        const meta = (l.metadata || {}) as Record<string, unknown>;
        return meta.outcome === 'failure' || meta.is_failure === true || meta.last_outcome === 'failure';
      });

      if (failureLessons.length >= 2) {
        const summaries = failureLessons.slice(0, 2).map(l => l.summary.substring(0, 80));
        warnings.push(`Similar tasks have failed before: ${summaries.join('; ')}`);
      }

      // Check for budget-related lessons
      const budgetLessons = relatedLessons.filter((l) =>
        /budget|cost|expensive|cheap/i.test(l.summary)
      );

      let suggestedBudget: number | undefined;
      if (budgetLessons.length > 0) {
        const budgetMatch = budgetLessons[0].summary.match(/\$(\d+(?:\.\d+)?)/);
        if (budgetMatch) {
          suggestedBudget = parseFloat(budgetMatch[1]);
          if (failureLessons.some(l => /budget/i.test(l.summary))) {
            suggestedBudget *= 1.5; // Increase if budget-related failures
          }
        }
      }

      // Check for high-confidence user preferences
      const preferences = relatedLessons.filter((l) => {
        const meta = (l.metadata || {}) as Record<string, unknown>;
        return meta.lesson_category === 'user-preference' && (meta.confidence as number || 0) > 0.8;
      });

      for (const pref of preferences.slice(0, 2)) {
        warnings.push(`Remember: ${pref.summary.substring(0, 100)}`);
      }

      return { suggestedBudget, warnings };
    } catch (err) {
      this.runtime.logger.warn(`[rlm] getRecommendations error: ${err instanceof Error ? err.message : String(err)}`);
      return { warnings };
    }
  }
}
