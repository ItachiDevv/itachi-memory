import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';
import { MemoryService } from '../../itachi-memory/services/memory-service.js';

/**
 * Edit analyzer: runs every 15 minutes, detects patterns in recent edits.
 * Stores pattern observations to itachi_memories[pattern_observation].
 */
export const editAnalyzerWorker: TaskWorker = {
  name: 'ITACHI_EDIT_ANALYZER',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const codeIntel = runtime.getService<CodeIntelService>('itachi-code-intel');
      const memoryService = runtime.getService<MemoryService>('itachi-memory');
      if (!codeIntel || !memoryService) {
        runtime.logger.warn('[edit-analyzer] Services not available, skipping');
        return;
      }

      // Get edits from last 15 minutes
      const recentEdits = await codeIntel.getRecentEditsAllProjects(15);
      if (recentEdits.length < 2) {
        runtime.logger.info(`[edit-analyzer] Only ${recentEdits.length} recent edits, skipping`);
        return;
      }

      // Group by project
      const byProject: Record<string, Array<Record<string, unknown>>> = {};
      for (const edit of recentEdits) {
        const proj = edit.project as string;
        if (!byProject[proj]) byProject[proj] = [];
        byProject[proj].push(edit);
      }

      for (const [project, edits] of Object.entries(byProject)) {
        if (edits.length < 2) continue;

        const editSummary = edits.map(e =>
          `- ${e.edit_type} ${e.file_path} (+${e.lines_added}/-${e.lines_removed})${e.tool_name ? ` via ${e.tool_name}` : ''}`
        ).join('\n');

        const prompt = `Analyze these recent code edits for project "${project}" and identify any patterns, themes, or notable observations. Be concise.

Edits (${edits.length} total):
${editSummary}

Identify:
1. What area of the codebase is being worked on?
2. Any repetitive patterns (same files, same types of changes)?
3. Potential concerns (too many files changed, only additions without tests)?

Respond in 2-3 sentences. Focus on actionable observations.`;

        const result = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
          temperature: 0.3,
        });

        const observation = typeof result === 'string' ? result : String(result);
        if (!observation || observation.length < 20) continue;

        const files = [...new Set(edits.map(e => e.file_path as string))];

        await memoryService.storeMemory({
          project,
          category: 'pattern_observation',
          content: observation,
          summary: `Pattern: ${observation.substring(0, 100)}`,
          files: files.slice(0, 10),
          branch: (edits[0].branch as string) || 'main',
        });

        runtime.logger.info(`[edit-analyzer] Stored pattern observation for ${project} (${edits.length} edits)`);
      }
    } catch (error) {
      runtime.logger.error('[edit-analyzer] Error:', error);
    }
  },
};

export async function registerEditAnalyzerTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_EDIT_ANALYZER');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_EDIT_ANALYZER task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_EDIT_ANALYZER',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 15 * 60 * 1000, // 15 minutes
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_EDIT_ANALYZER repeating task (15min)');
  } catch (error) {
    runtime.logger.error('Failed to register edit analyzer task:', error);
  }
}
