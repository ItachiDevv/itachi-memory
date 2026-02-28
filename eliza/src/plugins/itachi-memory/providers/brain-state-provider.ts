import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { MemoryService } from '../services/memory-service.js';

export const brainStateProvider: Provider = {
  name: 'BRAIN_STATE',
  description: 'Synthesized insights from session learning and universal project rules',
  dynamic: false,
  position: 7,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!memoryService) return { text: '', values: {}, data: {} };

      const supabase = memoryService.getSupabase();
      const project = (message.metadata as Record<string, unknown>)?.project as string | undefined;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Two parallel queries: synthesized insights + universal project rules
      const [insightsResult, rulesResult] = await Promise.all([
        supabase
          .from('itachi_memories')
          .select('id, project, summary, metadata, created_at')
          .eq('category', 'synthesized_insight')
          .gte('created_at', sevenDaysAgo)
          .in('project', project ? [project, '_general'] : ['_general'])
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('itachi_memories')
          .select('id, project, summary, metadata, created_at')
          .eq('category', 'project_rule')
          .eq('project', '_general')
          .gte('created_at', thirtyDaysAgo)
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

      const insights = insightsResult.data ?? [];
      const rules = rulesResult.data ?? [];

      if (insightsResult.error) runtime.logger.warn('BRAIN_STATE: insights query error:', insightsResult.error.message);
      if (rulesResult.error) runtime.logger.warn('BRAIN_STATE: rules query error:', rulesResult.error.message);

      // Dedup by summary, skip entries < 20 chars
      const seen = new Set<string>();
      const dedup = <T extends { summary: string }>(items: T[]): T[] =>
        items.filter((item) => {
          if (!item.summary || item.summary.length < 20 || seen.has(item.summary)) return false;
          seen.add(item.summary);
          return true;
        });

      const filteredInsights = dedup(insights);
      const filteredRules = dedup(rules);

      runtime.logger.info(`BRAIN_STATE: fetched insights=${filteredInsights.length} generalRules=${filteredRules.length}`);

      if (filteredInsights.length === 0 && filteredRules.length === 0) {
        return { text: '', values: {}, data: {} };
      }

      const parts = ['## Brain Knowledge'];

      if (filteredInsights.length > 0) {
        parts.push('### Recent Insights');
        for (const m of filteredInsights) {
          const ago = getTimeAgo(m.created_at);
          parts.push(`- ${m.summary} (${m.project}, ${ago})`);
        }
      }

      if (filteredRules.length > 0) {
        parts.push('### Universal Rules');
        for (const m of filteredRules) {
          const ago = getTimeAgo(m.created_at);
          parts.push(`- ${m.summary} (${ago})`);
        }
      }

      return {
        text: parts.join('\n'),
        values: {
          insightCount: String(filteredInsights.length),
          ruleCount: String(filteredRules.length),
        },
        data: { insights: filteredInsights, rules: filteredRules },
      };
    } catch (error) {
      runtime.logger.error('brainStateProvider error:', error instanceof Error ? error.message : String(error));
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
