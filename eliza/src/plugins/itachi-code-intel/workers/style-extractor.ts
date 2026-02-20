import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';

/**
 * Style extractor: runs weekly, analyzes sessions across all projects
 * to extract global coding style preferences.
 * Stores as single itachi_memories row with category 'global_style_profile', project '_global'.
 */
let lastStyleExtractorRun = 0;
const STYLE_EXTRACTOR_INTERVAL_MS = 604_800_000; // Weekly

export const styleExtractorWorker: TaskWorker = {
  name: 'ITACHI_STYLE_EXTRACTOR',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    return Date.now() - lastStyleExtractorRun >= STYLE_EXTRACTOR_INTERVAL_MS;
  },

  execute: async (runtime: IAgentRuntime, _options: { [key: string]: unknown }, _task: unknown): Promise<void> => {
    try {
      const codeIntel = runtime.getService('itachi-code-intel') as CodeIntelService | null;
      const memoryService = runtime.getService('itachi-memory') as MemoryService | null;
      if (!codeIntel || !memoryService) {
        runtime.logger.warn('[style-extractor] Services not available');
        return;
      }

      const supabase = codeIntel.getSupabase();

      // Get recent session summaries across all projects
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: sessions } = await supabase
        .from('session_summaries')
        .select('project, summary, key_decisions, patterns_used, files_changed')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(30);

      if (!sessions || sessions.length < 3) {
        runtime.logger.info('[style-extractor] Not enough sessions for style extraction');
        return;
      }

      // Get recent edits for language/tool distribution
      const { data: edits } = await supabase
        .from('session_edits')
        .select('language, tool_name, file_path')
        .gte('created_at', since)
        .limit(500);

      // Build language distribution
      const langCounts: Record<string, number> = {};
      const toolCounts: Record<string, number> = {};
      for (const edit of (edits || [])) {
        if (edit.language) langCounts[edit.language] = (langCounts[edit.language] || 0) + 1;
        if (edit.tool_name) toolCounts[edit.tool_name] = (toolCounts[edit.tool_name] || 0) + 1;
      }

      const sessionDetails = sessions.map(s =>
        `- [${s.project}] ${s.summary || '(no summary)'}\n  Decisions: ${(s.key_decisions || []).join('; ') || 'none'}\n  Patterns: ${(s.patterns_used || []).join('; ') || 'none'}`
      ).join('\n');

      const prompt = `Analyze these coding sessions across multiple projects to extract the developer's coding style preferences and conventions.

Sessions (${sessions.length} total):
${sessionDetails}

Languages used: ${Object.entries(langCounts).sort(([,a],[,b]) => b - a).map(([l,c]) => `${l}(${c})`).join(', ') || 'unknown'}
Tools used: ${Object.entries(toolCounts).sort(([,a],[,b]) => b - a).map(([t,c]) => `${t}(${c})`).join(', ') || 'unknown'}

Extract a global style profile as a JSON object with these keys:
- naming: preferred naming convention (camelCase, snake_case, etc.)
- testing: testing approach and framework preferences
- imports: import style preferences (named, default, barrel exports)
- formatting: code formatting preferences observed
- architecture: preferred architectural patterns
- error_handling: error handling approach
- libraries: commonly used libraries and frameworks
- commit_style: commit message conventions

Respond with ONLY the JSON object, no markdown code blocks.`;

      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.3,
      });

      const styleText = typeof result === 'string' ? result : String(result);
      if (!styleText || styleText.length < 20) return;

      // Try to parse as JSON for clean storage
      let styleContent = styleText;
      try {
        const cleaned = styleText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        JSON.parse(cleaned); // validate it's JSON
        styleContent = cleaned;
      } catch {
        // Not valid JSON — store as-is
      }

      // Delete old global style profile
      const { data: existing } = await supabase
        .from('itachi_memories')
        .select('id')
        .eq('project', '_global')
        .eq('category', 'global_style_profile');

      if (existing) {
        for (const old of existing) {
          await supabase.from('itachi_memories').delete().eq('id', old.id);
        }
      }

      await memoryService.storeMemory({
        project: '_global',
        category: 'global_style_profile',
        content: styleContent,
        summary: 'Global coding style profile',
        files: [],
      });

      lastStyleExtractorRun = Date.now();
      runtime.logger.info('[style-extractor] Updated global style profile');
    } catch (error: unknown) {
      runtime.logger.error('[style-extractor] Error:', error instanceof Error ? error.message : String(error));
    }
  },
};

export async function registerStyleExtractorTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_STYLE_EXTRACTOR');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_STYLE_EXTRACTOR task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_STYLE_EXTRACTOR',
      description: 'Weekly global coding style profile extraction',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 7 * 24 * 60 * 60 * 1000, // Weekly
      },
      tags: ['repeat'],
    } as any);
    runtime.logger.info('Registered ITACHI_STYLE_EXTRACTOR repeating task (weekly)');
  } catch (error: unknown) {
    runtime.logger.error('Failed to register style extractor task:', error instanceof Error ? error.message : String(error));
  }
}
