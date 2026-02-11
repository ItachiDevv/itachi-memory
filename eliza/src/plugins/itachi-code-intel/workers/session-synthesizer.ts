import { type TaskWorker, type IAgentRuntime, ModelType } from '@elizaos/core';
import { CodeIntelService } from '../services/code-intel-service.js';

/**
 * Session synthesizer: queue-based worker that enriches session summaries with LLM.
 * Triggered when a session completes (finds unsummarized sessions).
 */
export const sessionSynthesizerWorker: TaskWorker = {
  name: 'ITACHI_SESSION_SYNTHESIZER',

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,

  execute: async (runtime: IAgentRuntime): Promise<void> => {
    try {
      const codeIntel = runtime.getService<CodeIntelService>('itachi-code-intel');
      if (!codeIntel) {
        runtime.logger.warn('[session-synthesizer] CodeIntelService not available');
        return;
      }

      const supabase = codeIntel.getSupabase();

      // Find sessions without embeddings (not yet synthesized)
      const { data: unsummarized, error } = await supabase
        .from('session_summaries')
        .select('*')
        .is('embedding', null)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      if (!unsummarized || unsummarized.length === 0) {
        runtime.logger.info('[session-synthesizer] No unsummarized sessions');
        return;
      }

      for (const session of unsummarized) {
        try {
          // Get all edits for this session
          const { data: edits } = await supabase
            .from('session_edits')
            .select('file_path, edit_type, lines_added, lines_removed, language, diff_content')
            .eq('session_id', session.session_id)
            .order('created_at', { ascending: true })
            .limit(50);

          // Skip empty sessions — mark with placeholder to avoid re-processing
          if (!edits || edits.length === 0) {
            const zeroEmbedding = new Array(1536).fill(0);
            await supabase
              .from('session_summaries')
              .update({
                summary: 'Empty session — no edits recorded',
                embedding: zeroEmbedding,
              })
              .eq('id', session.id);
            runtime.logger.info(`[session-synthesizer] Skipped empty session ${session.session_id}`);
            continue;
          }

          const editSummary = (edits || []).map(e =>
            `- ${e.edit_type} ${e.file_path} (+${e.lines_added}/-${e.lines_removed})`
          ).join('\n');

          const diffs = (edits || [])
            .filter(e => e.diff_content)
            .map(e => `--- ${e.file_path} ---\n${(e.diff_content as string).substring(0, 500)}`)
            .join('\n\n')
            .substring(0, 3000);

          const prompt = `Summarize this coding session for project "${session.project}".

Session info:
- Duration: ${session.duration_ms ? Math.round(session.duration_ms / 60000) + ' min' : 'unknown'}
- Exit reason: ${session.exit_reason || 'unknown'}
- Files changed: ${(session.files_changed || []).join(', ') || 'unknown'}
- Lines: +${session.total_lines_added || 0}/-${session.total_lines_removed || 0}

Edits (${(edits || []).length} total):
${editSummary || '(no edits recorded)'}

${diffs ? `Sample diffs:\n${diffs}` : ''}

Provide:
1. **Summary** (2-3 sentences): What was accomplished?
2. **Key decisions** (bullet list): What architectural or design choices were made?
3. **Patterns used** (list): What coding patterns, libraries, or approaches were used?

Be specific and technical.`;

          const result = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt,
            temperature: 0.3,
          });

          const synthesized = typeof result === 'string' ? result : String(result);
          if (!synthesized || synthesized.length < 30) continue;

          // Parse structured response
          const keyDecisions: string[] = [];
          const patternsUsed: string[] = [];
          let summaryText = synthesized;

          // Extract key decisions
          const decisionsMatch = synthesized.match(/key decisions[:\s]*\n((?:[-*]\s+.+\n?)+)/i);
          if (decisionsMatch) {
            const lines = decisionsMatch[1].split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'));
            keyDecisions.push(...lines.map(l => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean));
          }

          // Extract patterns
          const patternsMatch = synthesized.match(/patterns used[:\s]*\n((?:[-*]\s+.+\n?)+)/i);
          if (patternsMatch) {
            const lines = patternsMatch[1].split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'));
            patternsUsed.push(...lines.map(l => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean));
          }

          // Extract summary section
          const summaryMatch = synthesized.match(/summary[:\s]*\n(.+?)(?=\n\n|\nkey decisions|\npatterns)/is);
          if (summaryMatch) {
            summaryText = summaryMatch[1].trim();
          }

          // Generate embedding for the session
          const embedding = await codeIntel.getEmbedding(
            `${session.project}: ${summaryText}. Files: ${(session.files_changed || []).join(', ')}`
          );

          // Update the session summary
          await supabase
            .from('session_summaries')
            .update({
              summary: summaryText.substring(0, 1000),
              key_decisions: keyDecisions.slice(0, 10),
              patterns_used: patternsUsed.slice(0, 10),
              embedding,
            })
            .eq('id', session.id);

          runtime.logger.info(`[session-synthesizer] Enriched session ${session.session_id} for ${session.project}`);
        } catch (sessionErr) {
          runtime.logger.error(`[session-synthesizer] Error processing session ${session.session_id}:`, sessionErr);
        }
      }
    } catch (error) {
      runtime.logger.error('[session-synthesizer] Error:', error);
    }
  },
};

export async function registerSessionSynthesizerTask(runtime: IAgentRuntime): Promise<void> {
  try {
    const existing = await runtime.getTasksByName('ITACHI_SESSION_SYNTHESIZER');
    if (existing && existing.length > 0) {
      runtime.logger.info('ITACHI_SESSION_SYNTHESIZER task already exists, skipping');
      return;
    }

    await runtime.createTask({
      name: 'ITACHI_SESSION_SYNTHESIZER',
      worldId: runtime.agentId,
      metadata: {
        updateInterval: 30 * 60 * 1000, // 30 minutes — sessions complete infrequently
      },
      tags: ['repeat'],
    });
    runtime.logger.info('Registered ITACHI_SESSION_SYNTHESIZER repeating task (5min)');
  } catch (error) {
    runtime.logger.error('Failed to register session synthesizer task:', error);
  }
}
