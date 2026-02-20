import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';

/**
 * Repo expertise builder: runs daily, builds per-project expertise map.
 * Stores to itachi_memories[repo_expertise] — one per project.
 */
let lastRepoExpertiseRun = 0;
const REPO_EXPERTISE_INTERVAL_MS = 86_400_000; // Daily

export const repoExpertiseWorker: TaskWorker = {
  name: 'ITACHI_REPO_EXPERTISE',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return Date.now() - lastRepoExpertiseRun >= REPO_EXPERTISE_INTERVAL_MS;
  },

  execute: async (runtime: IAgentRuntime, _options: { [key: string]: unknown }, _task: unknown): Promise<void> => {
    try {
      const codeIntel = runtime.getService('itachi-code-intel') as CodeIntelService | null;
      const memoryService = runtime.getService('itachi-memory') as MemoryService | null;
      if (!codeIntel || !memoryService) {
        runtime.logger.warn('[repo-expertise] Services not available');
        return;
      }

      const projects = await codeIntel.getActiveProjects();
      if (projects.length === 0) {
        runtime.logger.info('[repo-expertise] No active projects found');
        return;
      }

      for (const project of projects) {
        try {
          const supabase = codeIntel.getSupabase();

          // Get session summaries for this project (last 30 days)
          const since = new Date(Date.now() - 30 * 86400000).toISOString();
          const { data: sessions } = await supabase
            .from('session_summaries')
            .select('summary, files_changed, key_decisions, patterns_used, duration_ms, created_at')
            .eq('project', project)
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(20);

          // Get hot files
          const hotFiles = await codeIntel.getHotFiles(project, 30);

          // Get pattern observations
          const { data: patterns } = await supabase
            .from('itachi_memories')
            .select('summary, content')
            .eq('project', project)
            .eq('category', 'pattern_observation')
            .order('created_at', { ascending: false })
            .limit(10);

          if ((!sessions || sessions.length === 0) && hotFiles.length === 0) {
            runtime.logger.info(`[repo-expertise] No data for ${project}, skipping`);
            continue;
          }

          const sessionSummaries = (sessions || []).map(s =>
            `- ${s.summary || '(no summary)'} (${s.files_changed?.length || 0} files, ${Math.round((s.duration_ms || 0) / 60000)}min)`
          ).join('\n');

          const hotFilesSummary = hotFiles.map(f =>
            `- ${f.path} (${f.editCount} edits)`
          ).join('\n');

          const patternsSummary = (patterns || []).map(p =>
            `- ${p.summary}`
          ).join('\n');

          const prompt = `Build a concise expertise document for project "${project}" based on recent activity.

Recent sessions (${(sessions || []).length}):
${sessionSummaries || '(none)'}

Most-edited files:
${hotFilesSummary || '(none)'}

Observed patterns:
${patternsSummary || '(none)'}

Create a structured expertise document:
1. **Project Focus**: What is this project about? What areas are actively being developed?
2. **Architecture**: What architectural patterns are evident from the file changes?
3. **Key Files**: Which files are critical and frequently modified?
4. **Conventions**: What coding patterns, naming conventions, or approaches are used?
5. **Active Work**: What's currently being worked on?
6. **Gotchas**: Any potential issues, repetitive problems, or things to watch out for?

Keep it under 400 words. Be specific — this will be injected into Claude Code sessions.`;

          const result = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt,
            temperature: 0.4,
          });

          const expertise = typeof result === 'string' ? result : String(result);
          if (!expertise || expertise.length < 50) continue;

          // Delete old expertise doc for this project
          const { data: existing } = await supabase
            .from('itachi_memories')
            .select('id')
            .eq('project', project)
            .eq('category', 'repo_expertise')
            .order('created_at', { ascending: false });

          if (existing && existing.length > 0) {
            // Keep only the latest, delete the rest
            for (const old of existing) {
              await supabase.from('itachi_memories').delete().eq('id', old.id);
            }
          }

          await memoryService.storeMemory({
            project,
            category: 'repo_expertise',
            content: expertise,
            summary: `Expertise map for ${project}`,
            files: hotFiles.slice(0, 5).map(f => f.path),
          });

          runtime.logger.info(`[repo-expertise] Updated expertise for ${project}`);
        } catch (projErr: unknown) {
          runtime.logger.error(`[repo-expertise] Error for project ${project}:`, projErr instanceof Error ? projErr.message : String(projErr));
        }
      }

      lastRepoExpertiseRun = Date.now();
    } catch (error: unknown) {
      runtime.logger.error('[repo-expertise] Error:', error instanceof Error ? error.message : String(error));
    }
  },
};

export async function registerRepoExpertiseTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_REPO_EXPERTISE');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_REPO_EXPERTISE task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_REPO_EXPERTISE',
      description: 'Daily per-project expertise map builder',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 24 * 60 * 60 * 1000, // Daily
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_REPO_EXPERTISE repeating task (daily)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register repo expertise task:', error instanceof Error ? error.message : String(error));
  }
}
