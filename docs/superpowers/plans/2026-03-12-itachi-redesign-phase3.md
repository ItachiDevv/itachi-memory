# Itachi Phase 3: Session Shadow + Smart Retrieval

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Itachi's memory system smarter (trust filtering, auto-guardrails, prediction calibration) and add real-time session monitoring with proactive Telegram nudges + on-demand memory-grounded consulting.

**Architecture:** Five features built incrementally: (1) trust-score filtering on memory retrieval so low-confidence memories don't pollute context, (2) automatic guardrail creation from task failures, (3) real-time transcript watcher that monitors coding sessions and nudges via Telegram, (4) on-demand consult handler for mid-session questions, (5) prediction-outcome calibration to track estimation accuracy over time.

**Tech Stack:** ElizaOS, TypeScript, Supabase (PostgreSQL + pgvector RPCs), Node.js fs.watch, Telegram Bot API, launchd

**Spec:** `docs/superpowers/specs/2026-03-11-itachi-redesign-design.md` (Sections: Trust-Scored Memory Tiers, RLM Feedback Loops, Four Session Shadow Layers)

---

## File Structure

### Files to CREATE
```
eliza/src/plugins/itachi-tasks/services/guardrail-service.ts    # Extract failure patterns → guardrail memories
tools/session-watcher.mjs                                        # Standalone real-time transcript watcher daemon
tools/com.itachi.session-watcher.plist                           # launchd service definition
supabase/migrations/20260312000000_trust_and_predictions.sql     # Trust filtering + prediction fields
```

### Files to MODIFY
```
eliza/src/plugins/itachi-memory/services/memory-service.ts       # Add min_confidence param to search methods
eliza/src/plugins/itachi-tasks/services/task-executor-service.ts  # Wire guardrails into buildPrompt, add predictions
eliza/src/plugins/itachi-tasks/services/rlm-service.ts            # (in itachi-self-improve) Wire guardrail creation on failure
eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts       # Add memory-grounded question handler
eliza/src/plugins/itachi-tasks/services/task-service.ts           # Add prediction fields to ItachiTask interface
```

### Files REFERENCED (no changes)
```
eliza/src/plugins/itachi-tasks/services/session-driver.ts         # SessionDriver phase/state for watcher context
eliza/src/plugins/itachi-tasks/shared/parsed-chunks.ts            # ParsedChunk types
eliza/src/plugins/itachi-tasks/utils/transcript-analyzer.ts       # Existing transcript analysis patterns
hooks/unix/session-end.sh                                         # Session-end hook (insight extraction patterns)
```

---

## Chunk 1: Trust-Scored Memory Retrieval

### Task 1: Add trust filtering to Supabase RPCs

**Files:**
- Create: `supabase/migrations/20260312000000_trust_and_predictions.sql`

Add `min_confidence` parameter to both `match_memories` and `match_memories_hybrid` RPCs. Also add prediction columns to `itachi_tasks` (used in Task 8).

- [ ] **Step 1: Create the migration file**

```sql
-- Trust-scored memory filtering + prediction-outcome calibration fields
-- Additive migration — extends existing RPCs with optional min_confidence param

-- 1. Index for confidence filtering performance
CREATE INDEX IF NOT EXISTS idx_itachi_memories_confidence
ON itachi_memories ((metadata->>'confidence'));

-- 2. Update match_memories with min_confidence filter
CREATE OR REPLACE FUNCTION match_memories(
    query_embedding vector(1536),
    match_project text DEFAULT NULL,
    match_category text DEFAULT NULL,
    match_branch text DEFAULT NULL,
    match_metadata_outcome text DEFAULT NULL,
    match_limit int DEFAULT 5,
    min_confidence float DEFAULT NULL
) RETURNS TABLE (
    id uuid, project text, category text, content text,
    summary text, files text[], branch text, task_id uuid,
    metadata jsonb, created_at timestamptz, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT m.id, m.project, m.category, m.content, m.summary,
        m.files, m.branch, m.task_id, m.metadata, m.created_at,
        1 - (m.embedding <=> query_embedding) AS similarity
    FROM itachi_memories m
    WHERE (match_project IS NULL OR m.project = match_project)
        AND (match_category IS NULL OR m.category = match_category)
        AND (match_branch IS NULL OR m.branch = match_branch)
        AND (match_metadata_outcome IS NULL OR m.metadata->>'outcome' = match_metadata_outcome)
        AND (min_confidence IS NULL OR COALESCE((m.metadata->>'confidence')::float, 0.5) >= min_confidence)
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_limit;
END; $$;

-- 3. Update match_memories_hybrid with min_confidence filter
CREATE OR REPLACE FUNCTION match_memories_hybrid(
    query_embedding vector(1536),
    query_text text DEFAULT '',
    match_project text DEFAULT NULL,
    match_category text DEFAULT NULL,
    match_branch text DEFAULT NULL,
    match_metadata_outcome text DEFAULT NULL,
    match_limit int DEFAULT 5,
    vector_weight float DEFAULT 0.7,
    text_weight float DEFAULT 0.3,
    min_confidence float DEFAULT NULL
) RETURNS TABLE (
    id uuid, project text, category text, content text,
    summary text, files text[], branch text, task_id uuid,
    metadata jsonb, created_at timestamptz, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    WITH vec AS (
        SELECT m.id,
               1 - (m.embedding <=> query_embedding) AS vec_score
        FROM itachi_memories m
        WHERE (match_project IS NULL OR m.project = match_project)
          AND (match_category IS NULL OR m.category = match_category)
          AND (match_branch IS NULL OR m.branch = match_branch)
          AND (match_metadata_outcome IS NULL OR m.metadata->>'outcome' = match_metadata_outcome)
          AND (min_confidence IS NULL OR COALESCE((m.metadata->>'confidence')::float, 0.5) >= min_confidence)
        ORDER BY m.embedding <=> query_embedding
        LIMIT match_limit * 3
    ),
    fts AS (
        SELECT m.id,
               ts_rank_cd(m.search_vector, websearch_to_tsquery('english', query_text)) AS fts_score
        FROM itachi_memories m
        WHERE query_text IS NOT NULL
          AND query_text <> ''
          AND m.search_vector @@ websearch_to_tsquery('english', query_text)
          AND (match_project IS NULL OR m.project = match_project)
          AND (match_category IS NULL OR m.category = match_category)
          AND (match_branch IS NULL OR m.branch = match_branch)
          AND (match_metadata_outcome IS NULL OR m.metadata->>'outcome' = match_metadata_outcome)
          AND (min_confidence IS NULL OR COALESCE((m.metadata->>'confidence')::float, 0.5) >= min_confidence)
        LIMIT match_limit * 3
    ),
    combined AS (
        SELECT COALESCE(v.id, f.id) AS combined_id,
               vector_weight * COALESCE(v.vec_score, 0) +
               text_weight * COALESCE(f.fts_score, 0) AS combined_score
        FROM vec v
        FULL OUTER JOIN fts f ON v.id = f.id
    )
    SELECT m.id, m.project, m.category, m.content, m.summary,
           m.files, m.branch, m.task_id, m.metadata, m.created_at,
           c.combined_score AS similarity
    FROM combined c
    JOIN itachi_memories m ON m.id = c.combined_id
    ORDER BY c.combined_score DESC
    LIMIT match_limit;
END; $$;

-- 4. Add prediction fields to itachi_tasks (used in Task 8)
ALTER TABLE itachi_tasks ADD COLUMN IF NOT EXISTS predicted_difficulty text;
ALTER TABLE itachi_tasks ADD COLUMN IF NOT EXISTS predicted_duration_minutes int;
ALTER TABLE itachi_tasks ADD COLUMN IF NOT EXISTS actual_duration_minutes int;
ALTER TABLE itachi_tasks ADD COLUMN IF NOT EXISTS prediction_accuracy float;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply the migration to Supabase**

```bash
cd /Users/itachisan/itachi/itachi-memory && npx supabase db push --linked 2>&1 | tail -10
```

Expected: Migration applied successfully, no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260312000000_trust_and_predictions.sql
git commit -m "feat: add trust filtering to memory RPCs + prediction fields on tasks"
```

---

### Task 2: Wire trust filtering into MemoryService.searchMemories

**Files:**
- Modify: `eliza/src/plugins/itachi-memory/services/memory-service.ts:220-260`

Add optional `minConfidence` parameter to `searchMemories()` and `searchMemoriesHybrid()`. Pass it through to Supabase RPCs.

- [ ] **Step 1: Add minConfidence to searchMemories signature and RPC calls**

In `memory-service.ts`, find the `searchMemories` method (around line 220). Update the signature to accept `minConfidence`:

```typescript
async searchMemories(
  query: string,
  project?: string,
  limit = 5,
  branch?: string,
  category?: string,
  outcome?: string,
  minConfidence?: number,  // NEW — filter out low-trust memories
): Promise<ItachiMemory[]> {
```

Then update both RPC calls inside the method to pass `min_confidence`:

For `match_memories_hybrid` (around line 228):
```typescript
const { data, error } = await this.supabase.rpc('match_memories_hybrid', {
  query_embedding: embedding,
  query_text: query,
  match_project: project ?? null,
  match_category: category ?? null,
  match_branch: branch ?? null,
  match_metadata_outcome: outcome ?? null,
  match_limit: limit,
  min_confidence: minConfidence ?? null,  // NEW
});
```

For the `match_memories` fallback (around line 248):
```typescript
const { data, error } = await this.supabase.rpc('match_memories', {
  query_embedding: embedding,
  match_project: project ?? null,
  match_category: category ?? null,
  match_branch: branch ?? null,
  match_metadata_outcome: outcome ?? null,
  match_limit: limit,
  min_confidence: minConfidence ?? null,  // NEW
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/itachisan/itachi/itachi-memory/eliza && npx tsc --noEmit 2>&1 | grep "memory-service" | head -5
```

Expected: No new errors in memory-service.ts.

- [ ] **Step 3: Commit**

```bash
git add eliza/src/plugins/itachi-memory/services/memory-service.ts
git commit -m "feat: add minConfidence trust filtering to searchMemories"
```

---

### Task 3: Apply trust filtering in buildPrompt context injection

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts:704-735`

Update `buildPrompt()` to use `minConfidence: 0.4` for general memories and `minConfidence: 0.6` for project rules and lessons (higher bar for things injected as instructions).

- [ ] **Step 1: Update the three searchMemories calls in buildPrompt**

In `task-executor-service.ts`, find `buildPrompt()` (line 660). Update the memory fetch calls:

General memories (line 707):
```typescript
const memories = await memoryService.searchMemories(task.description, task.project, 5, undefined, undefined, undefined, 0.4);
```

Project rules (line 716):
```typescript
const rules = await memoryService.searchMemories(task.project, task.project, 5, undefined, 'project_rule', undefined, 0.6);
```

Past task lessons (line 725):
```typescript
const lessons = await memoryService.searchMemories(
  `${task.project} task outcome`, task.project, 3, undefined, 'task_lesson', undefined, 0.5
);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/itachisan/itachi/itachi-memory/eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/task-executor-service.ts
git commit -m "feat: apply trust-score filtering to task prompt context injection"
```

---

## Chunk 2: Failure-to-Guardrail Pipeline

### Task 4: Create GuardrailService

**Files:**
- Create: `eliza/src/plugins/itachi-tasks/services/guardrail-service.ts`

When a task fails, extract the failure pattern and create a `guardrail` category memory. Also provides `getGuardrails()` for injection into prompts.

- [ ] **Step 1: Create guardrail-service.ts**

```typescript
// eliza/src/plugins/itachi-tasks/services/guardrail-service.ts
import { Service, type IAgentRuntime, ModelType } from '@elizaos/core';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';

export class GuardrailService extends Service {
  static serviceType = 'guardrails';
  capabilityDescription = 'Extracts failure patterns into guardrails for future sessions';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<GuardrailService> {
    const service = new GuardrailService(runtime);
    runtime.logger.info('GuardrailService started');
    return service;
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('GuardrailService stopped');
  }

  /**
   * Extract a guardrail from a failed task's transcript and store it.
   * Called from handleSessionComplete when a task fails.
   */
  async createFromFailure(
    taskId: string,
    project: string,
    description: string,
    transcript: string,
    errorMessage?: string,
  ): Promise<string | null> {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return null;

    try {
      // Use LLM to extract the failure pattern and guardrail
      const prompt = [
        'A coding task failed. Extract a concise guardrail rule that would prevent this failure in future similar tasks.',
        '',
        `Task: ${description.substring(0, 300)}`,
        `Error: ${(errorMessage || 'unknown').substring(0, 300)}`,
        '',
        'Transcript (last portion):',
        transcript.substring(Math.max(0, transcript.length - 2000)),
        '',
        'Respond with ONLY a JSON object:',
        '{"pattern": "when doing X...", "guardrail": "always check Y first", "severity": "high"|"medium"|"low"}',
        '',
        'If the failure is too generic or not extractable (e.g. timeout with no clear cause), respond: {"pattern": null}',
      ].join('\n');

      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        system: 'You extract failure patterns into actionable guardrails. Be specific and concise. Output valid JSON only.',
      });

      const text = typeof response === 'string' ? response : (response as { text: string }).text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.pattern) return null;

      const guardrailText = `When ${parsed.pattern}: ${parsed.guardrail}`;

      // Check for duplicate guardrails
      const existing = await memoryService.searchMemories(
        guardrailText, project, 3, undefined, 'guardrail', undefined, undefined,
      );
      const isDuplicate = existing.some(e => (e.similarity ?? 0) > 0.85);
      if (isDuplicate) {
        // Reinforce existing guardrail confidence instead
        const best = existing[0];
        const conf = ((best.metadata as Record<string, unknown>)?.confidence as number) || 0.5;
        await memoryService.reinforceMemory(best.id, {
          confidence: Math.min(conf + 0.1, 0.99),
          last_triggered_by: taskId,
        });
        this.runtime.logger.info(`[guardrails] Reinforced existing guardrail ${best.id} (conf: ${conf} → ${Math.min(conf + 0.1, 0.99)})`);
        return best.id;
      }

      // Store new guardrail
      const stored = await memoryService.storeMemory({
        project,
        category: 'guardrail',
        content: guardrailText,
        summary: `[${parsed.severity}] ${guardrailText.substring(0, 150)}`,
        files: [],
        task_id: taskId,
        metadata: {
          pattern: parsed.pattern,
          guardrail: parsed.guardrail,
          severity: parsed.severity,
          confidence: 0.5,
          source: 'failure_extraction',
          source_task: taskId,
          created_at: new Date().toISOString(),
        },
      });

      this.runtime.logger.info(`[guardrails] Created guardrail from task ${taskId.substring(0, 8)}: "${guardrailText.substring(0, 80)}"`);
      return stored?.id || null;
    } catch (err) {
      this.runtime.logger.warn(`[guardrails] Failed to extract guardrail: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Get relevant guardrails for a project + task description.
   * Used by buildPrompt to inject warnings.
   */
  async getGuardrails(project: string, description: string, limit = 5): Promise<string[]> {
    const memoryService = this.runtime.getService<MemoryService>('itachi-memory');
    if (!memoryService) return [];

    try {
      const guardrails = await memoryService.searchMemories(
        description, project, limit, undefined, 'guardrail', undefined, 0.4,
      );
      return guardrails
        .filter(g => (g.similarity ?? 0) > 0.3)
        .map(g => g.summary || g.content || '')
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/itachisan/itachi/itachi-memory/eliza && npx tsc --noEmit 2>&1 | grep "guardrail-service" | head -5
```

Expected: No errors in guardrail-service.ts.

- [ ] **Step 3: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/guardrail-service.ts
git commit -m "feat: add GuardrailService — extracts failure patterns into guardrail memories"
```

---

### Task 5: Wire guardrail creation into handleSessionComplete + buildPrompt

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts:1584-1602` (failure handler)
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts:660-742` (buildPrompt)

- [ ] **Step 1: Add GuardrailService import at top of task-executor-service.ts**

After the existing RLM import (around line 16):

```typescript
import { GuardrailService } from './guardrail-service.js';
```

- [ ] **Step 2: Wire guardrail creation after RLM recording in handleSessionComplete**

In `handleSessionComplete()`, after the RLM recording block (after line 1602), add:

```typescript
    // 6b. Create guardrail from failure for future prevention
    if (finalStatus === 'failed' || finalStatus === 'timeout') {
      try {
        const guardrailService = this.runtime.getService<GuardrailService>('guardrails');
        if (guardrailService) {
          const transcriptText = transcript?.map(t => t.content).join('\n').substring(0, 3000) || '';
          await guardrailService.createFromFailure(
            task.id, task.project, task.description, transcriptText,
            updatePayload.error_message as string | undefined,
          );
        }
      } catch (err) {
        this.runtime.logger.warn(`[executor] Guardrail extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
```

- [ ] **Step 3: Inject guardrails into buildPrompt**

In `buildPrompt()`, after the lessons block (after line 735), add:

```typescript
        // Fetch guardrails (failure-derived warnings)
        try {
          const guardrailService = this.runtime.getService<GuardrailService>('guardrails');
          if (guardrailService) {
            const guardrails = await guardrailService.getGuardrails(task.project, task.description, 5);
            if (guardrails.length > 0) {
              lines.push('', '--- Guardrails (known failure patterns — follow these) ---');
              for (const g of guardrails) {
                lines.push(`- ${g}`);
              }
            }
          }
        } catch { /* non-critical */ }
```

- [ ] **Step 4: Register GuardrailService in the plugin**

In `eliza/src/plugins/itachi-tasks/index.ts`, add the import and registration:

```typescript
import { GuardrailService } from './services/guardrail-service.js';
```

Add to the services array in the plugin definition:
```typescript
services: [/* ...existing */, GuardrailService],
```

And add export:
```typescript
export { GuardrailService } from './services/guardrail-service.js';
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/itachisan/itachi/itachi-memory/eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/task-executor-service.ts eliza/src/plugins/itachi-tasks/services/guardrail-service.ts eliza/src/plugins/itachi-tasks/index.ts
git commit -m "feat: wire guardrail extraction on task failure + inject guardrails into buildPrompt"
```

---

## Chunk 3: Real-Time Transcript Watcher

### Task 6: Build the session watcher daemon

**Files:**
- Create: `tools/session-watcher.mjs`

Standalone Node.js script that tails active Claude Code `.jsonl` session files, detects repeated errors and known footguns, and sends Telegram nudges. Runs as a background daemon via launchd.

- [ ] **Step 1: Create session-watcher.mjs**

```javascript
#!/usr/bin/env node
// tools/session-watcher.mjs
// Real-time Claude Code session monitor — sends Telegram nudges on detected issues
// Runs as: launchd service or `node tools/session-watcher.mjs`

import { readFileSync, statSync, readdirSync, watch } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import https from 'https';

// ── Config ──────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
const BRAIN_API = process.env.BRAIN_API_URL || 'https://itachisbrainserver.online/api';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CHECK_INTERVAL_MS = 10_000; // Check for new sessions every 10s
const MIN_NUDGE_INTERVAL_MS = 120_000; // Don't nudge more than once per 2 min per session

// ── State ───────────────────────────────────────────────────────────────

const watchedSessions = new Map(); // path → { offset, lastNudge, errorCount, errors }

// ── Telegram ────────────────────────────────────────────────────────────

function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`[watcher] Would nudge: ${text.substring(0, 100)}`);
    return;
  }
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'Markdown',
    disable_notification: false,
  });
  const url = new URL(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`);
  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', (err) => console.error(`[watcher] Telegram error: ${err.message}`));
  req.write(payload);
  req.end();
}

// ── Guardrail check via brain API ───────────────────────────────────────

async function checkGuardrails(text, project) {
  if (!BRAIN_API) return [];
  try {
    const res = await fetch(`${BRAIN_API}/memory/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text.substring(0, 200), project, category: 'guardrail', limit: 3 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.memories || [])
      .filter(m => (m.similarity || 0) > 0.5)
      .map(m => m.summary || m.content);
  } catch {
    return [];
  }
}

// ── Session parsing ─────────────────────────────────────────────────────

function parseTurns(jsonlChunk) {
  const turns = [];
  for (const line of jsonlChunk.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      turns.push(obj);
    } catch { /* skip malformed lines */ }
  }
  return turns;
}

function detectIssues(turns, sessionState) {
  const issues = [];

  for (const turn of turns) {
    const text = (turn.message?.content || turn.content || '').toString().toLowerCase();

    // Detect repeated errors
    const errorPatterns = [
      /error\s*ts\d+/g,       // TypeScript errors
      /error:\s+(.{10,60})/g, // Generic errors
      /failed\s+to\s+/g,      // Build/test failures
      /command\s+failed/g,     // CLI failures
      /ENOENT|EACCES|EPERM/g,  // File system errors
    ];

    for (const pattern of errorPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const match of matches) {
          sessionState.errors.push(match);
          sessionState.errorCount++;
        }
      }
    }

    // Detect stuck loops (same error 3+ times)
    const errorFreq = {};
    for (const err of sessionState.errors.slice(-20)) {
      errorFreq[err] = (errorFreq[err] || 0) + 1;
    }
    for (const [err, count] of Object.entries(errorFreq)) {
      if (count >= 3) {
        issues.push({ type: 'stuck_loop', error: err, count });
      }
    }

    // Detect dangerous patterns
    if (/rm\s+-rf\s+[/~]/.test(text)) {
      issues.push({ type: 'dangerous_command', detail: 'rm -rf on root or home directory' });
    }
    if (/force.push|push.*--force/.test(text)) {
      issues.push({ type: 'dangerous_command', detail: 'force push detected' });
    }
    if (/drop\s+table|truncate\s+table/i.test(text)) {
      issues.push({ type: 'dangerous_command', detail: 'destructive SQL operation' });
    }
  }

  return issues;
}

// ── Session discovery and tailing ───────────────────────────────────────

function findActiveSessions() {
  const sessions = [];
  try {
    const projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = join(PROJECTS_DIR, dir.name);
      try {
        const files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const fullPath = join(projectPath, file);
          try {
            const stat = statSync(fullPath);
            // Active = modified in last 5 minutes
            if (Date.now() - stat.mtimeMs < 5 * 60 * 1000) {
              sessions.push({
                path: fullPath,
                project: dir.name,
                size: stat.size,
                sessionId: basename(file, '.jsonl'),
              });
            }
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* projects dir doesn't exist yet */ }
  return sessions;
}

async function tailSession(session) {
  const state = watchedSessions.get(session.path) || {
    offset: Math.max(0, session.size - 5000), // Start near end for existing sessions
    lastNudge: 0,
    errorCount: 0,
    errors: [],
  };
  watchedSessions.set(session.path, state);

  // Read new data since last offset
  const currentSize = statSync(session.path).size;
  if (currentSize <= state.offset) return;

  const fd = readFileSync(session.path, 'utf-8');
  const newData = fd.substring(state.offset);
  state.offset = currentSize;

  if (!newData.trim()) return;

  // Parse and analyze
  const turns = parseTurns(newData);
  if (turns.length === 0) return;

  const issues = detectIssues(turns, state);

  // Check guardrails for recent text
  const recentText = turns.map(t => (t.message?.content || t.content || '').toString()).join(' ').substring(0, 500);
  const guardrailHits = await checkGuardrails(recentText, session.project);

  // Combine issues
  const allIssues = [...issues];
  for (const g of guardrailHits) {
    allIssues.push({ type: 'guardrail_match', detail: g });
  }

  // Nudge if there are issues and cooldown has passed
  if (allIssues.length > 0 && Date.now() - state.lastNudge > MIN_NUDGE_INTERVAL_MS) {
    state.lastNudge = Date.now();

    const lines = [`*Session Watcher Alert*`, `Project: \`${session.project}\``];
    const seen = new Set();
    for (const issue of allIssues.slice(0, 5)) {
      const key = `${issue.type}:${issue.error || issue.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (issue.type === 'stuck_loop') {
        lines.push(`  Stuck loop: \`${issue.error}\` (${issue.count}x)`);
      } else if (issue.type === 'dangerous_command') {
        lines.push(`  Dangerous: ${issue.detail}`);
      } else if (issue.type === 'guardrail_match') {
        lines.push(`  Guardrail: ${issue.detail}`);
      }
    }
    sendTelegram(lines.join('\n'));
  }
}

// ── Main loop ───────────────────────────────────────────────────────────

async function tick() {
  const sessions = findActiveSessions();
  for (const session of sessions) {
    try {
      await tailSession(session);
    } catch (err) {
      console.error(`[watcher] Error tailing ${session.path}: ${err.message}`);
    }
  }

  // Clean up stale session state (not modified in 10 min)
  for (const [path, state] of watchedSessions) {
    try {
      const stat = statSync(path);
      if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
        watchedSessions.delete(path);
      }
    } catch {
      watchedSessions.delete(path);
    }
  }
}

console.log(`[session-watcher] Starting — monitoring ${PROJECTS_DIR}`);
console.log(`[session-watcher] Telegram: ${TELEGRAM_BOT_TOKEN ? 'configured' : 'NOT configured'}`);
console.log(`[session-watcher] Brain API: ${BRAIN_API || 'NOT configured'}`);

// Initial tick + interval
tick();
setInterval(tick, CHECK_INTERVAL_MS);
```

- [ ] **Step 2: Make executable and test**

```bash
chmod +x /Users/itachisan/itachi/itachi-memory/tools/session-watcher.mjs
node /Users/itachisan/itachi/itachi-memory/tools/session-watcher.mjs &
sleep 3 && kill %1 2>/dev/null
```

Expected: Prints startup message, no errors.

- [ ] **Step 3: Commit**

```bash
git add tools/session-watcher.mjs
git commit -m "feat: add real-time session watcher daemon for Telegram nudges"
```

---

### Task 7: Install session watcher as launchd service

**Files:**
- Create: `tools/com.itachi.session-watcher.plist`

- [ ] **Step 1: Create the launchd plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.itachi.session-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/itachisan/itachi/itachi-memory/tools/session-watcher.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>{{FILL_FROM_ENV}}</string>
        <key>TELEGRAM_GROUP_CHAT_ID</key>
        <string>{{FILL_FROM_ENV}}</string>
        <key>BRAIN_API_URL</key>
        <string>https://itachisbrainserver.online/api</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/session-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/session-watcher.err</string>
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>
```

- [ ] **Step 2: Install the service (fill env vars from current env first)**

```bash
# Copy plist, fill in actual env values
TBOT=$(grep TELEGRAM_BOT_TOKEN ~/.env 2>/dev/null | cut -d= -f2 || echo "$TELEGRAM_BOT_TOKEN")
TCHAT=$(grep TELEGRAM_GROUP_CHAT_ID ~/.env 2>/dev/null | cut -d= -f2 || echo "$TELEGRAM_GROUP_CHAT_ID")
NODE_PATH=$(which node)

sed -e "s|{{FILL_FROM_ENV}}|$TBOT|" \
    -e "s|{{FILL_FROM_ENV}}|$TCHAT|" \
    -e "s|/usr/local/bin/node|$NODE_PATH|" \
    /Users/itachisan/itachi/itachi-memory/tools/com.itachi.session-watcher.plist \
    > ~/Library/LaunchAgents/com.itachi.session-watcher.plist

launchctl load ~/Library/LaunchAgents/com.itachi.session-watcher.plist
launchctl list | grep itachi
```

Expected: Service appears in launchctl list.

- [ ] **Step 3: Verify it's running**

```bash
sleep 3 && cat /tmp/session-watcher.log | head -5
```

Expected: Shows `[session-watcher] Starting` message.

- [ ] **Step 4: Commit**

```bash
git add tools/com.itachi.session-watcher.plist
git commit -m "feat: add launchd plist for session watcher daemon"
```

---

## Chunk 4: On-Demand Consult + Prediction Calibration

### Task 8: Add memory-grounded question handler in Telegram

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts`

Currently when the intent router classifies a message as `question`, it returns `{ success: false }` and falls through to generic ElizaOS response. Instead, search memory for relevant context and generate a grounded answer.

- [ ] **Step 1: Replace the question intent handler**

In `telegram-commands.ts`, find the `intent.type === 'question'` block (around line 208). Replace:

```typescript
if (intent.type === 'question') {
  // Search memory and let LLM answer with context
  // For now, let ElizaOS handle naturally
  return { success: false };
}
```

With:

```typescript
if (intent.type === 'question') {
  try {
    const memoryService = runtime.getService<MemoryService>('itachi-memory');
    if (memoryService) {
      // Search multiple memory categories for relevant context
      const [memories, rules, lessons, guardrails] = await Promise.all([
        memoryService.searchMemories(text, intent.project || undefined, 5, undefined, undefined, undefined, 0.3),
        memoryService.searchMemories(text, intent.project || undefined, 3, undefined, 'project_rule', undefined, 0.5),
        memoryService.searchMemories(text, intent.project || undefined, 3, undefined, 'task_lesson', undefined, 0.4),
        memoryService.searchMemories(text, intent.project || undefined, 3, undefined, 'guardrail', undefined, 0.3),
      ]);

      const contextParts: string[] = [];
      for (const mem of [...memories, ...rules, ...lessons, ...guardrails]) {
        const entry = mem.summary || mem.content?.substring(0, 200);
        if (entry && !contextParts.includes(entry)) contextParts.push(entry);
      }

      if (contextParts.length > 0) {
        const grounded = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: [
            `Itachisan asks: "${text}"`,
            '',
            'Answer using this context from memory:',
            contextParts.slice(0, 10).map(c => `- ${c}`).join('\n'),
            '',
            'Be concise and direct. If the context doesn\'t cover the question, say so.',
          ].join('\n'),
          system: 'You are Itachi, answering your creator\'s question grounded in project memory and past sessions. Be helpful and specific.',
        });

        const answer = typeof grounded === 'string' ? grounded : (grounded as { text: string }).text;
        if (callback) await callback({ text: answer });
        return { success: true, data: { consultAnswer: true } };
      }
    }
  } catch (err) {
    runtime.logger.warn(`[telegram-commands] Consult search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Fall through to ElizaOS if memory search fails
  return { success: false };
}
```

- [ ] **Step 2: Add MemoryService and ModelType imports if not already present**

At the top of telegram-commands.ts, ensure these imports exist:

```typescript
import { ModelType } from '@elizaos/core';
import type { MemoryService } from '../../itachi-memory/services/memory-service.js';
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/itachisan/itachi/itachi-memory/eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts
git commit -m "feat: add memory-grounded on-demand consult for question intents"
```

---

### Task 9: Add prediction-outcome calibration to task pipeline

**Files:**
- Modify: `eliza/src/plugins/itachi-tasks/services/task-service.ts:4-31` (ItachiTask interface)
- Modify: `eliza/src/plugins/itachi-tasks/services/task-executor-service.ts` (executeTask + handleSessionComplete)

- [ ] **Step 1: Add prediction fields to ItachiTask interface**

In `task-service.ts`, add to the `ItachiTask` interface (around line 20, before `created_at`):

```typescript
  predicted_difficulty?: string;       // 'easy' | 'medium' | 'hard'
  predicted_duration_minutes?: number;
  actual_duration_minutes?: number;
  prediction_accuracy?: number;        // 0.0-1.0
```

Also add these to the allowed update fields array (around line 235):

```typescript
'predicted_difficulty', 'predicted_duration_minutes', 'actual_duration_minutes', 'prediction_accuracy',
```

- [ ] **Step 2: Add pre-task prediction in executeTask**

In `task-executor-service.ts`, in the `executeTask()` method, after the task is claimed but before `startSession()` is called (around line 500), add:

```typescript
    // Pre-task prediction for calibration
    try {
      const rlm = this.runtime.getService<RLMService>('rlm');
      if (rlm) {
        const recs = await rlm.getRecommendations(task.project, task.description);
        // Simple difficulty heuristic based on description length + warning count
        const descLen = task.description.length;
        const difficulty = recs.warnings.length >= 2 ? 'hard' : descLen > 300 ? 'medium' : 'easy';
        const durationEstimate = difficulty === 'hard' ? 20 : difficulty === 'medium' ? 10 : 5;

        await taskService.updateTask(task.id, {
          predicted_difficulty: difficulty,
          predicted_duration_minutes: durationEstimate,
        });
        this.runtime.logger.info(`[executor] Prediction for ${shortId}: ${difficulty}, ~${durationEstimate}min`);
      }
    } catch (err) {
      this.runtime.logger.warn(`[executor] Prediction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
```

- [ ] **Step 3: Add post-task calibration recording in handleSessionComplete**

In `handleSessionComplete()`, after the task status update (after line 1556), add:

```typescript
    // Record actual duration and calibrate prediction
    try {
      const startedAt = task.started_at ? new Date(task.started_at).getTime() : 0;
      if (startedAt > 0) {
        const actualMinutes = Math.round((Date.now() - startedAt) / 60_000);
        const predicted = task.predicted_duration_minutes || 0;
        const accuracy = predicted > 0
          ? Math.max(0, 1 - Math.abs(actualMinutes - predicted) / Math.max(predicted, actualMinutes))
          : 0;

        await taskService.updateTask(task.id, {
          actual_duration_minutes: actualMinutes,
          prediction_accuracy: Math.round(accuracy * 100) / 100,
        });
        this.runtime.logger.info(
          `[executor] Calibration for ${shortId}: predicted ${predicted}min, actual ${actualMinutes}min, accuracy ${(accuracy * 100).toFixed(0)}%`
        );
      }
    } catch (err) {
      this.runtime.logger.warn(`[executor] Calibration recording failed: ${err instanceof Error ? err.message : String(err)}`);
    }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/itachisan/itachi/itachi-memory/eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add eliza/src/plugins/itachi-tasks/services/task-service.ts eliza/src/plugins/itachi-tasks/services/task-executor-service.ts
git commit -m "feat: add prediction-outcome calibration to task pipeline"
```

---

## Chunk 5: Deploy and Verify

### Task 10: TypeScript verification and cleanup

- [ ] **Step 1: Full TypeScript check**

```bash
cd /Users/itachisan/itachi/itachi-memory/eliza && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: 0 errors (same as current baseline).

- [ ] **Step 2: Fix any new errors introduced by Phase 3 changes**

Address only errors introduced by Phase 3. Pre-existing errors (if any) are tracked separately.

- [ ] **Step 3: Commit if fixes needed**

```bash
git add -A && git commit -m "fix: resolve TypeScript errors from Phase 3 changes"
```

---

### Task 11: Push and deploy

- [ ] **Step 1: Push**

```bash
git push origin master
```

- [ ] **Step 2: Verify Coolify rebuilds**

Check that the Eliza bot container starts successfully on Hetzner.

---

### Task 12: End-to-end testing

- [ ] **Step 1: Test trust filtering**

Send a Telegram task for a project that has both high-confidence and low-confidence memories. Verify that `buildPrompt` only injects memories above the threshold by checking Eliza logs.

- [ ] **Step 2: Test guardrail creation**

Send a task that will fail (e.g., "implement X in nonexistent-repo"). After failure, check Supabase for a new `guardrail` category memory.

```sql
SELECT id, summary, metadata->>'confidence' as confidence
FROM itachi_memories
WHERE category = 'guardrail'
ORDER BY created_at DESC LIMIT 5;
```

- [ ] **Step 3: Test guardrail injection**

Send another similar task. Verify that the guardrail from Step 2 appears in the prompt context (check Eliza logs for "Guardrails" section).

- [ ] **Step 4: Test on-demand consult**

Send on Telegram: "how does the auth middleware work in itachi-memory?"

Expected: Intent classified as question → memory search → grounded answer (not generic ElizaOS response).

- [ ] **Step 5: Test session watcher**

Start a Claude Code session locally, intentionally trigger repeated errors. Check `/tmp/session-watcher.log` and Telegram for nudge alerts.

- [ ] **Step 6: Test prediction calibration**

Create and complete a task. Check Supabase:

```sql
SELECT id, predicted_difficulty, predicted_duration_minutes, actual_duration_minutes, prediction_accuracy
FROM itachi_tasks
ORDER BY created_at DESC LIMIT 3;
```

Expected: Prediction fields populated, accuracy calculated.

---

## Dependency Graph

```
Task 1 (Supabase migration) ── Task 2 (wire trust into MemoryService) ── Task 3 (trust in buildPrompt)
                                                                             │
Task 4 (GuardrailService) ── Task 5 (wire into executor + buildPrompt) ─────┤
                                                                             │
Task 6 (session watcher) ── Task 7 (launchd install) ───────────────────────┤
                                                                             │
Task 8 (on-demand consult) ──────────────────────────────────────────────────┤
                                                                             │
Task 9 (prediction calibration) ─────────────────────────────────────────────┤
                                                                             │
Task 10 (TS verify) ── Task 11 (deploy) ── Task 12 (E2E test)
```

Tasks 1→2→3 are sequential (schema before code before wiring).
Tasks 4→5 are sequential (service before wiring).
Tasks 6→7 are sequential (script before install).
Tasks 8 and 9 are independent of each other and of 4-7.
Tasks 10-12 depend on all implementation tasks.

---

## What's NOT in Phase 3 (deferred to Phase 4)

- **Differential context injection** — Track what was injected at session start, only inject deltas on subsequent prompts. Low priority; current approach works.
- **Judgment learning** — Recording when to use plan mode, extended thinking. Needs data collection over multiple sessions first.
- **Windows multi-turn** — PowerShell SSH stdin limitation. Known hard problem.
- **Entity-based knowledge notes** — Per-machine, per-project structured notes beyond current memory blocks.
- **Cross-machine memory sync** — Supabase is already source of truth; local caches are future optimization.
- **Memory web dashboard** — Browse, search, edit memories via web UI.

---

## Appendix: ElizaOS v3 (2.0.0) Migration Improvements

**Context:** We're on v2 (1.7.2). v3 is at 2.0.0-alpha.33 — not production-ready, but our plugins are already interface-compatible. When v3 stabilizes (beta/RC), migration is ~1-2 hours. Below are concrete improvements to adopt post-migration.

### Migration Steps (when v3 reaches beta)

1. Bump `@elizaos/core` to `^2.0.0`
2. Bump `@elizaos/plugin-anthropic`, `@elizaos/plugin-telegram`, `@elizaos/plugin-sql`, `@elizaos/plugin-openai` to `^2.0.0`
3. **Remove** `@elizaos/plugin-bootstrap` (now embedded in core)
4. Remove `postinstall` script (`patch-sql-plugin.mjs`) if no longer needed
5. Verify TaskWorker signatures accept new third `task` parameter

### v3 Features → Itachi Improvements

#### 1. Action Parameters (structured extraction)
**What:** Actions can declare typed parameters that the LLM extracts automatically from conversation.
**Current:** `telegram-commands.ts` uses regex (`TASK_PATTERNS`) + intent router LLM call to parse task descriptions, projects, machines from natural language.
**Improvement:** Define `parameters: ActionParameter[]` on the telegram action:
```typescript
parameters: [
  { name: 'intent', type: 'string', description: 'task | question | feedback | conversation' },
  { name: 'description', type: 'string', description: 'What the user wants done' },
  { name: 'project', type: 'string', description: 'Target project/repo name', optional: true },
  { name: 'machine', type: 'string', description: 'Target machine', optional: true },
]
```
**Impact:** Eliminates the manual `classifyIntent()` LLM call — v3 runtime extracts parameters before the handler runs. Saves one LLM round-trip per message.

#### 2. Native Triggers/Cron
**What:** v3 adds `TriggerConfig` with `interval`, `once`, `cron` types for scheduled tasks.
**Current:** We register custom `TaskWorker` instances via `registerXxxTask()` with manual polling intervals.
**Improvement:** Replace custom workers with declarative trigger configs:
```typescript
triggers: [
  { type: 'cron', cron: '*/2 * * * *', handler: 'processQueue' },      // Task queue polling
  { type: 'interval', interval: '5m', handler: 'checkReminders' },      // Reminder checks
  { type: 'interval', interval: '30m', handler: 'runReflection' },      // Self-improvement
]
```
**Impact:** Removes ~200 lines of custom worker registration/polling boilerplate across all 3 plugins.

#### 3. dynamicPromptExecFromState() (structured LLM output)
**What:** Schema-validated structured LLM output with automatic retries.
**Current:** GuardrailService uses manual JSON parsing: `const jsonMatch = text.match(/\{[\s\S]*\}/)`.
**Improvement:** Use structured extraction:
```typescript
const result = await runtime.dynamicPromptExecFromState({
  prompt: 'Extract the failure pattern...',
  schema: { pattern: 'string', guardrail: 'string', severity: '"high"|"medium"|"low"' },
});
// result is typed, validated, no manual JSON parsing needed
```
**Impact:** Eliminates fragile regex-based JSON extraction in guardrail service, transcript analyzer, and intent router. More reliable structured outputs.

#### 4. OBJECT_SMALL / OBJECT_LARGE ModelTypes
**What:** Dedicated model types for structured/JSON output.
**Current:** We use `ModelType.TEXT_SMALL` for everything including JSON extraction.
**Improvement:** Use `ModelType.OBJECT_SMALL` for guardrail extraction, prediction generation, intent classification — any call expecting structured JSON output.
**Impact:** Model provider can route to models optimized for structured output (e.g., JSON mode).

#### 5. Pre-Evaluators (trust gate)
**What:** Evaluators can run BEFORE memory storage with `phase: 'pre'`.
**Current:** Trust filtering happens only at retrieval time (searchMemories minConfidence).
**Improvement:** Add a pre-evaluator that assigns initial trust scores to memories before storage:
```typescript
{ name: 'trust-scorer', phase: 'pre', handler: async (runtime, message) => {
  // Score based on source reliability, corroboration with existing memories
  // Reject obviously low-quality memories before they're stored
}}
```
**Impact:** Prevents junk memories from being stored at all, not just filtered at retrieval. Cleaner memory database over time.

#### 6. Autonomy Mode
**What:** `enableAutonomy` flag for continuous agent loops — agent proactively acts without human prompts.
**Current:** Our brain loop is a custom interval that checks for queued tasks.
**Improvement:** Wire Itachi's proactive behaviors (task queue checking, reminder scanning, self-improvement) through v3's autonomy mode with proper lifecycle management.
**Impact:** Cleaner integration with the ElizaOS runtime lifecycle. Proper shutdown/restart handling.

#### 7. Message Bus (inter-agent communication)
**What:** Built-in message passing between agents.
**Current:** Multi-machine orchestration uses SSH + Supabase as coordination layer.
**Improvement:** If running multiple Itachi instances (e.g., one per machine), they could coordinate via Message Bus instead of polling Supabase.
**Impact:** Lower latency task handoffs between machines. Real-time status sync.

#### 8. registerSendHandler / sendMessageToTarget
**What:** Unified messaging primitives for cross-platform message routing.
**Current:** `TelegramTopicsService` has custom `sendToTopic()`, `sendMessageWithKeyboard()` methods.
**Improvement:** Register Telegram as a send handler, then use `runtime.sendMessageToTarget()` from anywhere — not just code that imports the Telegram service.
**Impact:** Decouples notification sending from Telegram-specific code. Session watcher, guardrail alerts, etc. could send notifications without knowing about Telegram.

#### 9. TEXT_REASONING_LARGE ModelType
**What:** Dedicated model type for complex reasoning (extended thinking).
**Current:** SessionDriver doesn't control which model Claude Code uses internally.
**Improvement:** For pre-task prediction and guardrail extraction, use `TEXT_REASONING_LARGE` for higher-quality analysis when the task is complex.
**Impact:** Better prediction accuracy on hard tasks. More nuanced guardrail extraction.

### Priority Order for v3 Adoption

1. **Action Parameters** — Biggest immediate win (eliminates intent router LLM call)
2. **dynamicPromptExecFromState** — Reliability win (structured outputs everywhere)
3. **Native Triggers** — Code cleanup (removes worker boilerplate)
4. **OBJECT_SMALL ModelType** — Easy swap, better JSON output
5. **Pre-Evaluators** — Memory quality improvement
6. **Autonomy Mode** — Architecture cleanup
7. **Message Bus** — Future multi-instance coordination
8. **sendMessageToTarget** — Decoupling improvement
9. **TEXT_REASONING_LARGE** — Quality improvement for complex analysis
