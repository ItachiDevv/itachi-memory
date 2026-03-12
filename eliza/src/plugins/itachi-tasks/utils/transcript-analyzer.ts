import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

export interface TranscriptEntry {
  type: 'text' | 'tool_use' | 'result' | 'user_input';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AnalysisContext {
  source: 'task' | 'session';
  project: string;
  taskId?: string;
  sessionId?: string;
  target?: string;
  description?: string;
  outcome?: string;
  durationMs?: number;
}

interface AnalysisResult {
  significance: number;
  capabilities: Array<{ summary: string; detail?: string }>;
}

/**
 * Format transcript entries into readable text, capped at maxChars.
 */
function formatTranscript(entries: TranscriptEntry[], maxChars: number = 6000): string {
  const lines: string[] = [];
  const baseTime = entries.length > 0 ? entries[0].timestamp : Date.now();
  let totalLen = 0;

  for (const entry of entries) {
    const elapsed = entry.timestamp - baseTime;
    const secs = Math.floor(elapsed / 1000);
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    const ts = `[${h}:${m}:${s}]`;

    let line: string;
    switch (entry.type) {
      case 'tool_use': {
        const filePath = (entry.metadata?.input as Record<string, unknown>)?.file_path
          || (entry.metadata?.input as Record<string, unknown>)?.path
          || (entry.metadata?.input as Record<string, unknown>)?.pattern
          || '';
        line = `${ts} [tool] ${entry.content}${filePath ? `: ${filePath}` : ''}`;
        break;
      }
      case 'user_input':
        line = `${ts} [user] ${entry.content}`;
        break;
      case 'result':
        line = `${ts} [result] ${entry.content.substring(0, 300)}`;
        break;
      default:
        line = `${ts} [text] ${entry.content.substring(0, 500)}`;
    }

    if (totalLen + line.length > maxChars) {
      lines.push('... (transcript truncated)');
      break;
    }
    lines.push(line);
    totalLen += line.length + 1;
  }

  return lines.join('\n');
}

/**
 * Analyze a task/session transcript via LLM and store extracted insights as memories.
 * Fire-and-forget — errors are caught internally and logged.
 */
export async function analyzeAndStoreTranscript(
  runtime: IAgentRuntime,
  transcript: TranscriptEntry[],
  context: AnalysisContext,
): Promise<void> {
  // Skip trivial transcripts
  if (transcript.length < 5) return;
  const totalContent = transcript.reduce((sum, e) => sum + e.content.length, 0);
  if (totalContent < 200) return;

  const memoryService = runtime.getService<MemoryService>('itachi-memory') as MemoryService | undefined;
  if (!memoryService) {
    runtime.logger.warn('[transcript-analyzer] MemoryService not available, skipping analysis');
    return;
  }

  const transcriptText = formatTranscript(transcript);
  const sourceLabel = context.source === 'task' ? 'task' : 'session';
  const tag = context.taskId?.substring(0, 8) || context.sessionId?.substring(0, 12) || 'unknown';

  const prompt = `Analyze this Claude Code ${context.source} transcript and extract capability knowledge — things learned that would help with similar tasks in the future.

Project: ${context.project}
Original task: ${context.description || 'none'}
Outcome: ${context.outcome || 'unknown'}
${context.durationMs ? `Duration: ${Math.round(context.durationMs / 1000)}s` : ''}

Transcript:
${transcriptText}

Extract capabilities: practical knowledge about HOW to do things. Focus on:
- Tools, commands, or techniques that worked (or didn't)
- Environment-specific knowledge (paths, permissions, dependencies)
- API endpoints, auth patterns, or integration details discovered
- Gotchas, workarounds, or non-obvious requirements

Only include insights clearly evidenced in the transcript. Skip trivial observations.

Respond ONLY with valid JSON:
{"significance": 0.7, "capabilities": [{"summary": "Short description of what was learned", "detail": "Full explanation with specifics"}]}`;

  let parsed: AnalysisResult;
  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.2,
    });

    const raw = typeof result === 'string' ? result : String(result);
    parsed = JSON.parse(raw.trim());

    if (typeof parsed.significance !== 'number' || !Array.isArray(parsed.capabilities)) {
      runtime.logger.warn(`[transcript-analyzer] Invalid LLM response structure for ${sourceLabel} ${tag}`);
      return;
    }
  } catch (err) {
    runtime.logger.warn(`[transcript-analyzer] LLM analysis failed for ${sourceLabel} ${tag}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Skip low-significance transcripts
  if (parsed.significance < 0.3 && parsed.capabilities.length === 0) {
    runtime.logger.info(`[transcript-analyzer] Skipping low-significance ${sourceLabel} ${tag} (${parsed.significance})`);
    return;
  }

  let stored = 0;
  let reinforced = 0;
  const project = context.project || 'default';

  for (const cap of parsed.capabilities.slice(0, 10)) {
    if (!cap.summary || cap.summary.length < 10) continue;

    try {
      const existing = await memoryService.searchMemories(
        cap.summary, project, 3, undefined, 'capability'
      );
      const best = existing.length > 0 ? existing[0] : null;

      if (best && (best.similarity ?? 0) > 0.85) {
        await memoryService.reinforceMemory(best.id, { source: `${sourceLabel}_transcript` });
        reinforced++;
      } else {
        await memoryService.storeMemory({
          project,
          category: 'capability',
          content: cap.detail || cap.summary,
          summary: cap.summary,
          files: [],
          metadata: {
            confidence: 0.7,
            times_reinforced: 1,
            source: `${sourceLabel}_transcript`,
            task_id: context.taskId,
            outcome: context.outcome,
            first_seen: new Date().toISOString(),
            last_reinforced: new Date().toISOString(),
          },
        });
        stored++;
      }
    } catch (err) {
      runtime.logger.warn(`[transcript-analyzer] Failed to store capability: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  runtime.logger.info(
    `[transcript-analyzer] ${sourceLabel} ${tag}: ${stored} stored, ${reinforced} reinforced ` +
    `(significance: ${parsed.significance})`
  );
}
