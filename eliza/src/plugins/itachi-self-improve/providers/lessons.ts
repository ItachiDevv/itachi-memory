import { type Provider, type IAgentRuntime, type Memory, type State, type ProviderResult } from '@elizaos/core';
import type { MemoryService, ItachiMemory } from '../../itachi-memory/services/memory-service.js';

export const lessonsProvider: Provider = {
  name: 'MANAGEMENT_LESSONS',
  description: 'Relevant management lessons from past decisions to improve future choices',
  dynamic: false,
  position: 5, // Early in context, before action decisions

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const query = message.content?.text || '';
      if (query.length < 5) return { text: '', values: {}, data: {} };

      // Use MemoryService (itachi_memories table) to search for task lessons.
      // This is the same storage that task-poller, topic-input-relay, lesson-extractor,
      // and /feedback write to — all with category='task_lesson'.
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return { text: '', values: {}, data: {} };

      let lessons;
      try {
        lessons = await memoryService.searchMemories(
          query,
          undefined,  // all projects
          5,
          undefined,
          'task_lesson',
        );
      } catch {
        // Embedding generation failed — return empty gracefully
        return { text: '', values: {}, data: {} };
      }

      if (!lessons || lessons.length === 0) return { text: '', values: {}, data: {} };

      const parts: string[] = ['## Past Management Lessons'];

      for (const l of lessons) {
        const meta = l.metadata || {};
        const confidence = (meta as Record<string, unknown>).confidence ?? '';
        const outcome = (meta as Record<string, unknown>).outcome ?? '';
        const category = (meta as Record<string, unknown>).lesson_category || l.category || 'task_lesson';
        const sim = l.similarity != null ? ` (relevance: ${l.similarity.toFixed(2)})` : '';
        parts.push(
          `- [${category}] ${l.summary}${confidence ? ` (confidence: ${confidence})` : ''}${outcome ? ` (outcome: ${outcome})` : ''}${sim}`
        );
      }

      // Also search for strategy documents (synthesized by reflection worker)
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
        values: { lessonCount: String(lessons.length) },
        data: { lessons, strategies },
      };
    } catch (error: unknown) {
      runtime.logger.error('lessonsProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '', values: {}, data: {} };
    }
  },
};
