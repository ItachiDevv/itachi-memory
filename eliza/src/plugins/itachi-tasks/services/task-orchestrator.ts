export interface CriterionResult {
  criterion: string;
  passed: boolean;
  reason?: string;
}

export interface TaskReport {
  status: 'success' | 'failed' | 'partial' | 'blocked';
  approach: 'direct' | 'planned';
  criteriaResults: CriterionResult[];
  summary: string;
  learned: string[];
  blockedReason?: string;
}

/**
 * Parse the ===ITACHI_REPORT=== block from Claude Code output.
 * Returns null if no report block found.
 */
export function parseReport(output: string): TaskReport | null {
  const match = output.match(/===ITACHI_REPORT===([\s\S]*?)===END_REPORT===/);
  if (!match) return null;

  const block = match[1].trim();
  const lines = block.split('\n').map(l => l.trim());

  const get = (key: string): string => {
    const line = lines.find(l => l.startsWith(`${key}:`));
    return line ? line.substring(key.length + 1).trim() : '';
  };

  // Parse criteria_results
  const criteriaResults: CriterionResult[] = [];
  let inCriteria = false;
  for (const line of lines) {
    if (line.startsWith('criteria_results:')) { inCriteria = true; continue; }
    if (inCriteria && line.startsWith('- "')) {
      const crMatch = line.match(/^- "(.+?)":\s*(pass|fail)(?:\s*—\s*(.+))?$/);
      if (crMatch) {
        criteriaResults.push({
          criterion: crMatch[1],
          passed: crMatch[2] === 'pass',
          reason: crMatch[3] || undefined,
        });
      }
    } else if (inCriteria && !line.startsWith('- "')) {
      inCriteria = false;
    }
  }

  // Parse learned (list)
  const learned: string[] = [];
  let inLearned = false;
  for (const line of lines) {
    if (line.startsWith('learned:')) { inLearned = true; continue; }
    if (inLearned && line.startsWith('- ')) {
      learned.push(line.substring(2).trim());
    } else if (inLearned && !line.startsWith('- ') && line.length > 0) {
      inLearned = false;
    }
  }

  return {
    status: get('status') as TaskReport['status'] || 'failed',
    approach: get('approach') as TaskReport['approach'] || 'direct',
    criteriaResults,
    summary: get('summary'),
    learned,
    blockedReason: get('blocked_reason') || undefined,
  };
}
