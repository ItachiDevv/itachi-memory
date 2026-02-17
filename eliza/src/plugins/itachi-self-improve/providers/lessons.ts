import { type Provider, type IAgentRuntime, type Memory, type State, type ProviderResult } from '@elizaos/core';
import type { MemoryService, ItachiMemory } from '../../itachi-memory/services/memory-service.js';

interface ScoredMemory extends ItachiMemory {
  weightedScore: number;
}

function computeWeightedScore(m: ItachiMemory): number {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const similarity = m.similarity ?? 0.5;
  const confidence = typeof meta.confidence === 'number' ? meta.confidence : 0.5;
  const daysOld = (Date.now() - Date.parse(m.created_at)) / 86_400_000;
  const recencyDecay = 1 / (1 + daysOld * 0.1);
  const timesReinforced = typeof meta.times_reinforced === 'number' ? meta.times_reinforced : 0;
  const reinforcementBonus = 1 + timesReinforced * 0.2;
  return similarity * confidence * recencyDecay * reinforcementBonus;
}

function formatLesson(m: ScoredMemory): string {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const confidence = typeof meta.confidence === 'number' ? meta.confidence.toFixed(2) : '?';
  const timesReinforced = typeof meta.times_reinforced === 'number' ? meta.times_reinforced : 0;
  return `- APPLY: ${m.summary} — confirmed (confidence: ${confidence}, reinforced ${timesReinforced}x)`;
}

function formatRule(m: ScoredMemory): string {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const confidence = typeof meta.confidence === 'number' ? meta.confidence.toFixed(2) : '?';
  const timesReinforced = typeof meta.times_reinforced === 'number' ? meta.times_reinforced : 0;
  return `- RULE: ${m.summary} — (confidence: ${confidence}, reinforced ${timesReinforced}x)`;
}

export const lessonsProvider: Provider = {
  name: 'MANAGEMENT_LESSONS',
  description: 'Relevant management lessons and project rules from past decisions to improve future choices',
  dynamic: false,
  position: 5,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const query = message.content?.text || '';
      if (query.length < 5) return { text: '', values: {}, data: {} };

      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return { text: '', values: {}, data: {} };

      // Search task_lesson and project_rule in parallel
      let rawLessons: ItachiMemory[] = [];
      let rawRules: ItachiMemory[] = [];
      try {
        [rawLessons, rawRules] = await Promise.all([
          memoryService.searchMemories(query, undefined, 12, undefined, 'task_lesson'),
          memoryService.searchMemories(query, undefined, 5, undefined, 'project_rule'),
        ]);
      } catch {
        return { text: '', values: {}, data: {} };
      }

      // Score and rank lessons
      const scoredLessons: ScoredMemory[] = (rawLessons || [])
        .map(m => ({ ...m, weightedScore: computeWeightedScore(m) }))
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 8);

      // Score and rank rules
      const scoredRules: ScoredMemory[] = (rawRules || [])
        .map(m => ({ ...m, weightedScore: computeWeightedScore(m) }))
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 3);

      if (scoredLessons.length === 0 && scoredRules.length === 0) {
        return { text: '', values: {}, data: {} };
      }

      const parts: string[] = [];

      if (scoredLessons.length > 0) {
        parts.push('## Past Management Lessons');
        for (const l of scoredLessons) {
          parts.push(formatLesson(l));
        }
      }

      if (scoredRules.length > 0) {
        parts.push('');
        parts.push('## Project Rules');
        for (const r of scoredRules) {
          parts.push(formatRule(r));
        }
      }

      // Strategy documents (synthesized by reflection worker)
      let strategies: ItachiMemory[] = [];
      try {
        strategies = await memoryService.searchMemories(
          'strategy management',
          undefined,
          2,
          undefined,
          'strategy_document',
        );
      } catch {
        strategies = [];
      }

      if (strategies && strategies.length > 0) {
        const latest = strategies[0];
        parts.push('');
        parts.push('## Current Strategy');
        parts.push(latest.summary?.substring(0, 500) || latest.content?.substring(0, 500) || '');
      }

      return {
        text: parts.join('\n'),
        values: { lessonCount: String(scoredLessons.length), ruleCount: String(scoredRules.length) },
        data: { lessons: scoredLessons, rules: scoredRules, strategies },
      };
    } catch (error: unknown) {
      runtime.logger.error('lessonsProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '', values: {}, data: {} };
    }
  },
};
