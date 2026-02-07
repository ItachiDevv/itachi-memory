import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const conversationContextProvider: Provider = {
  name: 'CONVERSATION_CONTEXT',
  description: 'Recent significant conversation memories from Telegram chats',
  dynamic: true,
  position: 11,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return { text: '', values: {}, data: {} };

      // Fetch recent conversation memories from last 24h
      const supabase = memoryService.getSupabase();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: memories, error } = await supabase
        .from('itachi_memories')
        .select('id, project, summary, metadata, created_at')
        .eq('category', 'conversation')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error || !memories?.length) return { text: '', values: {}, data: {} };

      // Filter out low-significance memories
      const significant = memories.filter((m) => {
        const sig = (m.metadata as Record<string, unknown>)?.significance;
        return typeof sig !== 'number' || sig >= 0.3;
      });

      if (significant.length === 0) return { text: '', values: {}, data: {} };

      const parts = ['## Recent Conversations'];
      for (const m of significant) {
        const sig = (m.metadata as Record<string, unknown>)?.significance;
        const sigLabel = typeof sig === 'number' ? ` [${sig.toFixed(1)}]` : '';
        const ago = getTimeAgo(m.created_at);
        parts.push(`- ${m.summary} (${m.project}, ${ago})${sigLabel}`);
      }

      return {
        text: parts.join('\n'),
        values: { conversationCount: String(significant.length) },
        data: { conversations: significant },
      };
    } catch (error) {
      runtime.logger.error('conversationContextProvider error:', error);
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
