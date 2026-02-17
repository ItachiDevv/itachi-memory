import { type Provider, type IAgentRuntime, type Memory, type State, type ProviderResult } from '@elizaos/core';
import type { MemoryService, ItachiMemory } from '../../itachi-memory/services/memory-service.js';

export const personalityProvider: Provider = {
  name: 'PERSONALITY',
  description: 'Dynamic personality traits learned from user interactions',
  dynamic: false,
  position: 3, // Very early — shapes ALL responses

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return { text: '', values: {}, data: {} };

      let traits: ItachiMemory[];
      try {
        traits = await memoryService.searchMemories(
          'personality communication style preferences tone',
          undefined,
          15,
          undefined,
          'personality_trait',
        );
      } catch {
        return { text: '', values: {}, data: {} };
      }

      if (!traits || traits.length === 0) return { text: '', values: {}, data: {} };

      // Score and rank by confidence x reinforcement
      const scored = traits.map((t) => {
        const meta = (t.metadata || {}) as Record<string, unknown>;
        const confidence = typeof meta.confidence === 'number' ? meta.confidence : 0.5;
        const timesReinforced = typeof meta.times_reinforced === 'number' ? meta.times_reinforced : 0;
        const reinforcementBonus = 1 + timesReinforced * 0.2;
        return { ...t, score: confidence * reinforcementBonus };
      });

      scored.sort((a, b) => b.score - a.score);
      const topTraits = scored.slice(0, 10);

      // Group by trait category
      const byCategory: Record<string, string[]> = {};
      for (const t of topTraits) {
        const cat = (t.metadata as Record<string, unknown>)?.trait_category as string || 'general';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(t.summary);
      }

      const parts: string[] = ['## Your Personality (learned from user interactions)'];

      if (byCategory.communication_tone) {
        parts.push(`Communication: ${byCategory.communication_tone.join('. ')}`);
      }
      if (byCategory.decision_style) {
        parts.push(`Decision style: ${byCategory.decision_style.join('. ')}`);
      }
      if (byCategory.priority_signals) {
        parts.push(`Priorities: ${byCategory.priority_signals.join('. ')}`);
      }
      if (byCategory.vocabulary_patterns) {
        parts.push(`Vocabulary: ${byCategory.vocabulary_patterns.join('. ')}`);
      }
      // Include any uncategorized traits
      for (const [cat, items] of Object.entries(byCategory)) {
        if (!['communication_tone', 'decision_style', 'priority_signals', 'vocabulary_patterns'].includes(cat)) {
          parts.push(`${cat}: ${items.join('. ')}`);
        }
      }

      if (parts.length <= 1) return { text: '', values: {}, data: {} };

      return {
        text: parts.join('\n'),
        values: { traitCount: String(topTraits.length) },
        data: { traits: topTraits },
      };
    } catch (error: unknown) {
      runtime.logger.error('personalityProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '', values: {}, data: {} };
    }
  },
};
