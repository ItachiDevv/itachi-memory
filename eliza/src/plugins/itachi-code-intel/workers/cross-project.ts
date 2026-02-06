import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';

/**
 * Cross-project correlator: runs weekly, finds patterns across all projects.
 * Stores to cross_project_insights table.
 */
export const crossProjectWorker: TaskWorker = {
  name: 'ITACHI_CROSS_PROJECT',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const codeIntel = runtime.getService<CodeIntelService>('itachi-code-intel');
      if (!codeIntel) {
        runtime.logger.warn('[cross-project] CodeIntelService not available');
        return;
      }

      // Get all repo expertise docs
      const expertiseDocs = await codeIntel.getAllProjectExpertise();
      if (expertiseDocs.length < 2) {
        runtime.logger.info('[cross-project] Need 2+ project expertise docs for cross-project analysis');
        return;
      }

      const docsText = expertiseDocs.map(d =>
        `## ${d.project}\n${(d.content as string).substring(0, 500)}`
      ).join('\n\n');

      const prompt = `Analyze these project expertise documents to find cross-project patterns, shared approaches, and reuse opportunities.

${docsText}

Identify up to 5 insights. For each, provide:
- type: one of (pattern, dependency, style, convention, library, antipattern)
- projects: which projects this applies to (array)
- title: short title (under 50 chars)
- description: explanation (under 200 chars)
- confidence: 0.0-1.0

Look for:
1. Shared patterns or approaches used across projects
2. Libraries or tools used in one project that would benefit another
3. Convention inconsistencies between related projects
4. Anti-patterns appearing in multiple projects
5. Reuse opportunities (code/config that could be shared)

Respond as a JSON array. No markdown code blocks.`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.4,
      });

      const responseText = typeof result === 'string' ? result : String(result);
      if (!responseText || responseText.length < 20) return;

      let insights: Array<{
        type: string;
        projects: string[];
        title: string;
        description: string;
        confidence: number;
      }>;

      try {
        const cleaned = responseText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        insights = JSON.parse(cleaned);
      } catch {
        runtime.logger.warn('[cross-project] Failed to parse LLM response as JSON');
        return;
      }

      if (!Array.isArray(insights)) return;

      const validTypes = new Set(['pattern', 'dependency', 'style', 'convention', 'library', 'antipattern']);

      for (const insight of insights.slice(0, 5)) {
        if (!insight.type || !validTypes.has(insight.type)) continue;
        if (!insight.projects || !Array.isArray(insight.projects) || insight.projects.length === 0) continue;
        if (!insight.title || !insight.description) continue;

        try {
          await codeIntel.storeCrossProjectInsight({
            insight_type: insight.type,
            projects: insight.projects,
            title: insight.title.substring(0, 100),
            description: insight.description.substring(0, 500),
            confidence: Math.max(0, Math.min(1, insight.confidence || 0.5)),
            evidence: [{ source: 'cross-project-worker', generated_at: new Date().toISOString() }],
          });
        } catch (err) {
          runtime.logger.error(`[cross-project] Failed to store insight "${insight.title}":`, err);
        }
      }

      runtime.logger.info(`[cross-project] Stored ${Math.min(insights.length, 5)} cross-project insights`);
    } catch (error) {
      runtime.logger.error('[cross-project] Error:', error);
    }
  },
};

export async function registerCrossProjectTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_CROSS_PROJECT');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_CROSS_PROJECT task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_CROSS_PROJECT',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 7 * 24 * 60 * 60 * 1000, // Weekly
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_CROSS_PROJECT repeating task (weekly)');
  } catch (error) {
    runtime.logger.error('Failed to register cross-project task:', error);
  }
}
