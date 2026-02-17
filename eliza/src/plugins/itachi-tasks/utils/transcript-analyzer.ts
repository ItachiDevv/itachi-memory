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

interface Insight {
  category: string;
  summary: string;
  steps?: string[];
  error?: string;
  fix?: string;
}

interface AnalysisResult {
  significance: number;
  effective_prompt_score: number;
  insights: Insight[];
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

  const prompt = `Analyze this Claude Code ${context.source} transcript and extract structured knowledge.

Project: ${context.project}
Source: ${context.source} (${context.target || 'task queue'})
Original prompt: ${context.description || 'none'}
Outcome: ${context.outcome || 'unknown'}
${context.durationMs ? `Duration: ${Math.round(context.durationMs / 1000)}s` : ''}

Transcript:
${transcriptText}

Extract the following categories of knowledge:

1. **workflow**: Step-by-step procedures that could be reused. Format: ordered steps.
   Example: "To fix a TypeScript build error: 1) Run bun run build 2) Check the error output 3) Fix type errors 4) Rebuild"

2. **cli_pattern**: Effective CLI prompts and commands that produced good results.
   Example: "Using 'itachi --ds' with a specific file path in the prompt helps focus the session"

3. **error_recovery**: How errors were diagnosed and fixed. Include the error and the fix.
   Example: "When SSH connection fails with 'Permission denied', check that the SSH key is loaded"

4. **project_rule**: Project-specific conventions, gotchas, or constraints discovered.
   Example: "Always run 'bun run build' before deploying itachi-memory"

5. **decision**: Technical decisions made and why.

6. **pattern**: Code patterns or architectural insights.

Also assess:
- significance (0.0-1.0): How valuable is this transcript for learning?
- effective_prompt_score (0.0-1.0): How well did the original prompt guide the session?

Only include insights that are clearly evidenced in the transcript. Skip trivial or obvious observations.

Respond ONLY with valid JSON, no markdown fences:
{"significance": 0.7, "effective_prompt_score": 0.8, "insights": [{"category": "workflow", "summary": "...", "steps": ["step1", "step2"]}, {"category": "cli_pattern", "summary": "..."}, {"category": "error_recovery", "summary": "...", "error": "...", "fix": "..."}, {"category": "project_rule", "summary": "..."}, {"category": "decision", "summary": "..."}, {"category": "pattern", "summary": "..."}]}`;

  let parsed: AnalysisResult;
  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.2,
    });

    const raw = typeof result === 'string' ? result : String(result);
    parsed = JSON.parse(raw.trim());

    if (typeof parsed.significance !== 'number' || !Array.isArray(parsed.insights)) {
      runtime.logger.warn(`[transcript-analyzer] Invalid LLM response structure for ${sourceLabel} ${tag}`);
      return;
    }
  } catch (err) {
    runtime.logger.warn(`[transcript-analyzer] LLM analysis failed for ${sourceLabel} ${tag}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Skip low-significance transcripts
  if (parsed.significance < 0.3 && parsed.insights.length === 0) {
    runtime.logger.info(`[transcript-analyzer] Skipping low-significance ${sourceLabel} ${tag} (${parsed.significance})`);
    return;
  }

  let stored = 0;
  let reinforced = 0;
  const project = context.project || 'default';

  for (const insight of parsed.insights.slice(0, 15)) {
    if (!insight.summary || insight.summary.length < 10) continue;

    try {
      if (insight.category === 'project_rule') {
        // Use reinforcement pattern: search for similar existing rules
        const existing = await memoryService.searchMemories(
          insight.summary, project, 3, undefined, 'project_rule'
        );
        const bestMatch = existing.length > 0 ? existing[0] : null;
        const matchSimilarity = bestMatch?.similarity ?? 0;

        if (bestMatch && matchSimilarity > 0.85) {
          await memoryService.reinforceMemory(bestMatch.id, {
            source: `${sourceLabel}_transcript`,
          });
          if (insight.summary.length > (bestMatch.summary?.length || 0)) {
            await memoryService.updateMemorySummary(bestMatch.id, insight.summary);
          }
          reinforced++;
        } else {
          await memoryService.storeMemory({
            project,
            category: 'project_rule',
            content: insight.summary,
            summary: insight.summary,
            files: [],
            metadata: {
              confidence: 0.7,
              times_reinforced: 1,
              source: `${sourceLabel}_transcript`,
              first_seen: new Date().toISOString(),
              last_reinforced: new Date().toISOString(),
              ...(context.taskId ? { task_id: context.taskId } : {}),
              ...(context.sessionId ? { session_id: context.sessionId } : {}),
            },
          });
          stored++;
        }
      } else {
        // Store other insight types with their category
        const metadata: Record<string, unknown> = {
          source: `${sourceLabel}_transcript`,
          significance: parsed.significance,
          ...(context.taskId ? { task_id: context.taskId } : {}),
          ...(context.sessionId ? { session_id: context.sessionId } : {}),
          ...(context.target ? { target: context.target } : {}),
        };

        if (insight.category === 'workflow' && insight.steps) {
          metadata.steps = insight.steps;
        }
        if (insight.category === 'cli_pattern') {
          metadata.effective_prompt_score = parsed.effective_prompt_score;
        }
        if (insight.category === 'error_recovery') {
          if (insight.error) metadata.error = insight.error;
          if (insight.fix) metadata.fix = insight.fix;
        }

        await memoryService.storeMemory({
          project,
          category: insight.category,
          content: insight.summary + (insight.steps ? '\nSteps: ' + insight.steps.join(' -> ') : ''),
          summary: insight.summary,
          files: [],
          metadata,
        });
        stored++;
      }
    } catch (err) {
      runtime.logger.warn(`[transcript-analyzer] Failed to store insight: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  runtime.logger.info(
    `[transcript-analyzer] ${sourceLabel} ${tag}: ${stored} stored, ${reinforced} reinforced ` +
    `(significance: ${parsed.significance}, prompt_score: ${parsed.effective_prompt_score})`
  );
}
