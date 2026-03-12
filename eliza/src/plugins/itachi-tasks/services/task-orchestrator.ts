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

export interface PromptInput {
  task: string;
  capabilities: string[];
  sshTargets: string[];
  repos: string[];
  retryContext?: {
    previousApproach: 'direct' | 'planned';
    failureSummary: string;
    forcePlanned: boolean;
  };
}

export function buildPrompt(input: PromptInput): string {
  const capSection = input.capabilities.length > 0
    ? input.capabilities.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : 'No prior capability memories for this type of task.';

  const sshSection = input.sshTargets.length > 0
    ? `- SSH access to: ${input.sshTargets.join(', ')}`
    : '- No remote machines configured';

  const repoSection = input.repos.length > 0
    ? `- Known repos: ${input.repos.join(', ')}`
    : '';

  let retrySection = '';
  if (input.retryContext) {
    retrySection = `
## PREVIOUS ATTEMPT FAILED
Approach used: ${input.retryContext.previousApproach}
What happened: ${input.retryContext.failureSummary}
${input.retryContext.forcePlanned ? 'You MUST plan first this time. Break the task into steps before executing.' : ''}
`;
  }

  return `You are Itachi, an autonomous AI agent. You run on a Hetzner VPS (your home machine).

## Who You Are
You work for Itachisan. You receive tasks via Telegram and execute them independently.
You are not a chatbot. You are a developer with root access to this machine.

## What You Have
- This machine (Hetzner VPS, Linux, your home)
${sshSection}
- Telegram bot token (available as $TELEGRAM_BOT_TOKEN env var)
- Supabase (available as $SUPABASE_URL and $SUPABASE_KEY env vars)
- GitHub: authenticated via gh CLI
- Internet access: curl, wget, npm, pip, apt, etc.
${repoSection}

## What You Know (Capability Memory)
${capSection}
${retrySection}
## The Task
${input.task}

## Protocol
1. ASSESS: Is this simple (just do it) or complex (plan first)?
   If you've done something similar before (check capability memory), lean toward direct.
   If this involves multiple systems or unknowns, plan first.

2. DEFINE SUCCESS: Before executing, write out concrete success criteria.
   What specific checks will prove this worked?

3. EXECUTE: Do the work. If you need something you don't have, figure it out.
   If you need another machine, SSH to it. If you need a package, install it.

4. VERIFY: Run each success criterion. Actually check — don't assume.

5. REPORT: Output the report block (format below). This is MANDATORY.

## Report Format
\`\`\`
===ITACHI_REPORT===
status: success | failed | partial | blocked
approach: direct | planned
criteria_results:
  - "criterion": pass | fail — reason
summary: What you did and what happened.
learned:
  - What you learned that would help with similar tasks in the future.
===END_REPORT===
\`\`\`

## Safety
For destructive or irreversible actions (deleting data, force-push, spending money,
sending external messages), STOP and include in your report:
  status: blocked
  blocked_reason: "Description of what needs confirmation"

## Rules
- Never ask for permission. Just do it. If it fails, report why.
- If you're unsure which machine to use, use this one (Hetzner).
- If a task involves recurring/scheduled work, set up an actual cron job or systemd timer.
- If you need to send results to Itachisan, use the Telegram bot API directly via curl.
- Always clean up after yourself (temp files, test artifacts).
- You MUST output the ===ITACHI_REPORT=== block at the end. No exceptions.`;
}
