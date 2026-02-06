import { type Provider, type IAgentRuntime, type Memory, type State, type ProviderResult, MemoryType } from '@elizaos/core';

export const lessonsProvider: Provider = {
  name: 'MANAGEMENT_LESSONS',
  description: 'Relevant management lessons from past decisions to improve future choices',
  dynamic: true,
  position: 5, // Early in context, before action decisions

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const query = message.content?.text || '';
      if (query.length < 5) return { text: '', values: {}, data: {} };

      // Search for relevant lessons
      const results = await runtime.searchMemories({
        type: MemoryType.CUSTOM,
        query,
        limit: 5,
        threshold: 0.6,
      });

      // Filter to management-lesson type
      const lessons = results.filter(
        (m) => m.metadata?.type === 'management-lesson'
      );

      if (lessons.length === 0) return { text: '', values: {}, data: {} };

      // Also look for strategy documents (higher-level synthesized lessons)
      const strategies = results.filter(
        (m) => m.metadata?.type === 'strategy-document'
      );

      const parts: string[] = ['## Past Management Lessons'];

      // Add individual lessons
      for (const l of lessons) {
        const meta = l.metadata || {};
        parts.push(
          `- [${meta.category}] ${l.content?.text} (confidence: ${meta.confidence}, outcome: ${meta.outcome})`
        );
      }

      // Add most recent strategy if available
      if (strategies.length > 0) {
        const latest = strategies[0];
        parts.push('');
        parts.push('## Current Strategy');
        parts.push(latest.content?.text?.substring(0, 500) || '');
      }

      return {
        text: parts.join('\n'),
        values: { lessonCount: String(lessons.length) },
        data: { lessons, strategies },
      };
    } catch (error) {
      runtime.logger.error('lessonsProvider error:', error);
      return { text: '', values: {}, data: {} };
    }
  },
};
