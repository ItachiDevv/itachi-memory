import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';

/**
 * Cross-project insights provider: injects relevant cross-project patterns.
 * Position 12 — lower priority, loaded after project-specific context.
 */
export const crossProjectInsightsProvider: Provider = {
  name: 'cross-project-insights',
  description: 'Patterns and insights found across multiple projects',
  position: 12,

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const codeIntel = runtime.getService('itachi-code-intel') as CodeIntelService | null;
      if (!codeIntel) return { text: '## Cross-Project Insights\nNo cross-project data available.' };

      const insights = await codeIntel.getCrossProjectInsights(5);
      if (insights.length === 0) return { text: '## Cross-Project Insights\nNo cross-project patterns detected yet.' };

      const lines: string[] = ['## Cross-Project Insights'];
      for (const insight of insights) {
        const projects = (insight.projects as string[]).join(', ');
        const confidence = ((insight.confidence as number) * 100).toFixed(0);
        lines.push(`- [${insight.insight_type}] ${insight.title} (${projects}) — ${confidence}% confidence`);
        lines.push(`  ${insight.description}`);
      }

      return { text: lines.join('\n') };
    } catch {
      return { text: '## Cross-Project Insights\nFailed to load cross-project data.' };
    }
  },
};
