import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const recentMemoriesProvider: Provider = {
  name: 'RECENT_PROJECT_MEMORIES',
  description: 'Recent project memories from coding sessions',
  dynamic: false,
  position: 10,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return { text: '', values: {}, data: {} };

      // Get recent + relevant memories
      const text = message.content?.text || '';
      const [recent, relevant] = await Promise.all([
        memoryService.getRecentMemories(undefined, 5),
        text.length > 10 ? memoryService.searchMemories(text, undefined, 3) : Promise.resolve([]),
      ]);

      const parts: string[] = [];

      if (relevant.length > 0) {
        parts.push('## Relevant Memories');
        for (const m of relevant) {
          parts.push(
            `- [${m.category}] ${m.summary} (project: ${m.project}, similarity: ${m.similarity?.toFixed(2) ?? 'N/A'})`
          );
        }
      }

      if (recent.length > 0) {
        parts.push('## Recent Changes');
        for (const m of recent) {
          const ago = getTimeAgo(m.created_at);
          parts.push(`- [${m.category}] ${m.summary} (${m.project}, ${ago})`);
        }
      }

      return {
        text: parts.length > 0 ? parts.join('\n') : '',
        values: {
          recentCount: String(recent.length),
          relevantCount: String(relevant.length),
        },
        data: { recent, relevant },
      };
    } catch (error) {
      runtime.logger.error('recentMemoriesProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '', values: {}, data: {} };
    }
  },
};

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
