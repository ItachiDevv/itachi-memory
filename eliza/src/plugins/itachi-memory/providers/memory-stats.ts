import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const memoryStatsProvider: Provider = {
  name: 'MEMORY_STATS',
  description: 'Summary statistics about stored project memories',
  dynamic: false,
  position: 80,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return { text: '', values: {}, data: {} };

      const stats = await memoryService.getStats();

      const categories = Object.entries(stats.byCategory)
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(', ');

      const text = `## Memory Stats\nTotal: ${stats.total} memories (${categories})`;

      return {
        text,
        values: { totalMemories: String(stats.total) },
        data: { stats },
      };
    } catch (error) {
      runtime.logger.error('memoryStatsProvider error:', error);
      return { text: '', values: {}, data: {} };
    }
  },
};
