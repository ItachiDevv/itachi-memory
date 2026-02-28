import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';
import type { MemoryService, ItachiMemory } from '../../itachi-memory/services/memory-service.js';

/**
 * Cross-project correlator: runs weekly, finds patterns across all projects.
 * Stores to cross_project_insights table.
 */
let lastCrossProjectRun = 0;
const CROSS_PROJECT_INTERVAL_MS = 604_800_000; // Weekly

export const crossProjectWorker: TaskWorker = {
  name: 'ITACHI_CROSS_PROJECT',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return Date.now() - lastCrossProjectRun >= CROSS_PROJECT_INTERVAL_MS;
  },

  execute: async (runtime: IAgentRuntime, _options: { [key: string]: unknown }, _task: unknown): Promise<void> => {
    try {
      const codeIntel = runtime.getService('itachi-code-intel') as CodeIntelService | null;
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
        } catch (err: unknown) {
          runtime.logger.error(`[cross-project] Failed to store insight "${insight.title}":`, err instanceof Error ? err.message : String(err));
        }
      }

      // ── Promote shared patterns to project='_general' ──────────────
      // Query project_rule and task_lesson across all projects.
      // If similar patterns appear in 3+ projects, promote to _general.
      try {
        const memoryService = runtime.getService<MemoryService>('itachi-memory');
        if (memoryService) {
          const supabase = memoryService.getSupabase();
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

          const { data: rules } = await supabase
            .from('itachi_memories')
            .select('id, project, summary, category, embedding')
            .in('category', ['project_rule', 'task_lesson'])
            .neq('project', '_general')
            .gte('created_at', thirtyDaysAgo)
            .order('created_at', { ascending: false })
            .limit(100);

          if (rules && rules.length >= 3) {
            // Group by similarity clusters — find patterns that appear in 3+ different projects
            const promoted = new Set<string>();
            for (const rule of rules) {
              if (promoted.has(rule.id) || !rule.summary || rule.summary.length < 20) continue;

              // Find similar rules across projects
              const { data: similar } = await supabase.rpc('match_memories', {
                query_embedding: rule.embedding,
                match_project: null,
                match_category: rule.category,
                match_branch: null,
                match_metadata_outcome: null,
                match_limit: 10,
              });

              if (!similar || similar.length < 3) continue;

              // Count distinct projects
              const projects = new Set((similar as ItachiMemory[]).filter(s => s.similarity! > 0.85).map(s => s.project));
              if (projects.size < 3) continue;

              // Check if already promoted to _general
              const { data: existingGeneral } = await supabase.rpc('match_memories', {
                query_embedding: rule.embedding,
                match_project: '_general',
                match_category: rule.category,
                match_branch: null,
                match_metadata_outcome: null,
                match_limit: 1,
              });

              if (existingGeneral?.length > 0 && existingGeneral[0].similarity > 0.9) {
                continue; // Already promoted
              }

              // Promote: store as _general
              await memoryService.storeMemory({
                project: '_general',
                category: rule.category,
                content: rule.summary,
                summary: `[universal] ${rule.summary}`,
                files: [],
                metadata: {
                  source: 'cross-project-promotion',
                  source_projects: [...projects],
                  promoted_at: new Date().toISOString(),
                },
              });

              promoted.add(rule.id);
              for (const s of similar as ItachiMemory[]) promoted.add(s.id);
              runtime.logger.info(`[cross-project] Promoted to _general: "${rule.summary.substring(0, 60)}" (${projects.size} projects)`);

              if (promoted.size > 20) break; // Cap promotions per cycle
            }

            if (promoted.size > 0) {
              runtime.logger.info(`[cross-project] Promoted ${promoted.size} patterns to _general`);
            }
          }
        }
      } catch (err: unknown) {
        runtime.logger.warn('[cross-project] Promotion phase error:', err instanceof Error ? err.message : String(err));
      }

      lastCrossProjectRun = Date.now();
      runtime.logger.info(`[cross-project] Stored ${Math.min(insights.length, 5)} cross-project insights`);
    } catch (error: unknown) {
      runtime.logger.error('[cross-project] Error:', error instanceof Error ? error.message : String(error));
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
      description: 'Weekly cross-project pattern analysis',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 7 * 24 * 60 * 60 * 1000, // Weekly
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_CROSS_PROJECT repeating task (weekly)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register cross-project task:', error instanceof Error ? error.message : String(error));
  }
}
