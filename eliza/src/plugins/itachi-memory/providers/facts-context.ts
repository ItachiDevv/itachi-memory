import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const factsContextProvider: Provider = {
  name: 'FACTS_CONTEXT',
  description: 'Known facts and user preferences from past conversations',
  dynamic: false,
  position: 9,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) {
        runtime.logger.warn('FACTS_CONTEXT: MemoryService not available, skipping');
        return { text: '', values: {}, data: {} };
      }

      const messageText = message.content?.text || '';

      // Fetch identity facts (permanent, always injected) + relevant + recent in parallel
      const [identity, relevant, recent] = await Promise.all([
        fetchIdentityFacts(memoryService, 50),
        messageText.length > 10
          ? memoryService.searchMemories(messageText, undefined, 8, undefined, 'fact')
          : Promise.resolve([]),
        fetchRecentFacts(memoryService, 10),
      ]);

      // Build output: identity first (always present), then contextual facts
      const seen = new Set<string>();
      const identityFacts: Array<{ summary: string; project: string }> = [];
      const contextFacts: Array<{ summary: string; project: string }> = [];

      // Identity tier: permanent core facts about the user
      for (const m of identity) {
        if (!seen.has(m.summary)) {
          seen.add(m.summary);
          identityFacts.push({ summary: m.summary, project: m.project });
        }
      }

      // Contextual tier: semantic search + recent time-windowed facts
      for (const m of relevant) {
        if (!seen.has(m.summary)) {
          seen.add(m.summary);
          contextFacts.push({ summary: m.summary, project: m.project });
        }
      }
      for (const m of recent) {
        if (!seen.has(m.summary)) {
          seen.add(m.summary);
          contextFacts.push({ summary: m.summary, project: m.project });
        }
      }

      const totalCount = identityFacts.length + contextFacts.length;
      runtime.logger.info(`FACTS_CONTEXT: fetched identity=${identityFacts.length} contextual=${contextFacts.length} (raw: identity=${identity.length} relevant=${relevant.length} recent=${recent.length})`);
      if (totalCount === 0) {
        return {
          text: '## Known Facts & Preferences\nNo stored facts yet.',
          values: { factCount: '0' },
          data: {},
        };
      }

      const parts: string[] = [];

      if (identityFacts.length > 0) {
        parts.push('## Core Identity & Relationship');
        parts.push('These are permanent facts about the user and your relationship:');
        for (const f of identityFacts) {
          parts.push(`- ${f.summary}`);
        }
      }

      if (contextFacts.length > 0) {
        parts.push('## Known Facts & Preferences');
        for (const f of contextFacts) {
          parts.push(`- ${f.summary}${f.project !== 'general' ? ` (${f.project})` : ''}`);
        }
      }

      return {
        text: parts.join('\n'),
        values: { factCount: String(totalCount) },
        data: { identity: identityFacts, facts: contextFacts },
      };
    } catch (error) {
      runtime.logger.error('factsContextProvider error:', error instanceof Error ? error.message : String(error));
      return { text: '', values: {}, data: {} };
    }
  },
};

/** Fetch permanent identity facts — no time window, always injected */
async function fetchIdentityFacts(
  memoryService: MemoryService,
  limit: number
): Promise<Array<{ summary: string; project: string }>> {
  const supabase = memoryService.getSupabase();

  const { data, error } = await supabase
    .from('itachi_memories')
    .select('summary, project')
    .eq('category', 'identity')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as Array<{ summary: string; project: string }>;
}

async function fetchRecentFacts(
  memoryService: MemoryService,
  limit: number
): Promise<Array<{ summary: string; project: string }>> {
  const supabase = memoryService.getSupabase();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('itachi_memories')
    .select('summary, project')
    .eq('category', 'fact')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as Array<{ summary: string; project: string }>;
}
