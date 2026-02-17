# Itachi RLM: Self-Learning Agent Architecture

## Context

The bot collects data well (memories, lessons, rules, session insights, facts) but **doesn't USE it**. Lessons are stored but inert. Local Claude Code sessions extract insights but those never reach the Telegram bot. Personality is static (`character.ts` hardcoded adjectives). Subagents exist but are invisible to the user. The vision: a digital CEO-proxy that learns from every interaction — Telegram, local sessions, task outcomes — and applies that knowledge to every future decision.

### 5 Critical Gaps (from codebase audit)
1. **RLM not wired into bot decisions** — lessons/rules stored in `itachi_memories` but bot doesn't apply them
2. **Local sessions don't feed RLM** — `extract-insights` stores with wrong categories, never reaches `lessonsProvider`
3. **Subagent learning isolated** — each agent learns alone, no shared knowledge
4. **No active decision shaping** — lessons are informational text, not prescriptive
5. **Personality is inert** — style profiles exist but don't shape communication

---

## Phase 1: Close the Learning Loop (Week 1-2)

**Goal**: Data that's already collected actually influences the bot's behavior.

### 1A. Fix the RLM Bridge — Session Insights → Task Lessons

**Problem**: `POST /api/session/extract-insights` (code-intel-routes.ts:249-458) stores high-significance insights as `MemoryType.CUSTOM` in ElizaOS native memory AND in `itachi_memories` with insight-specific categories (`preference`, `learning`, `decision`). But `lessonsProvider` only searches `category: 'task_lesson'`. **Result: session insights never appear in bot context.**

**File**: `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts`

**Fix**: In the RLM bridge section (~line 380-400), also store as `category: 'task_lesson'` in `itachi_memories` via MemoryService. Map categories:
- `preference` → lesson_category: `user-preference`
- `learning` → lesson_category: `error-handling`
- `decision` → lesson_category: `project-selection`
- `pattern` → lesson_category: `tool-selection`

This single change makes ALL session insights visible to `lessonsProvider` on the next Telegram message.

### 1B. Upgrade lessonsProvider → RLM-Aware Context

**Problem**: `lessonsProvider` (self-improve/providers/lessons.ts) does a single semantic search for `task_lesson` memories. No ranking by effectiveness, no project rules, no preference weighting.

**File**: `eliza/src/plugins/itachi-self-improve/providers/lessons.ts`

**Changes**:
1. Search BOTH `task_lesson` AND `project_rule` categories
2. Rank by: `relevance × confidence × recency_decay × reinforcement_bonus`
   - `recency_decay`: newer lessons score higher (e.g., `1 / (1 + days_old * 0.1)`)
   - `reinforcement_bonus`: `1 + (times_reinforced * 0.2)` for rules that were confirmed multiple times
3. Format as **directives**, not just observations:
   - Before: `"- [user-preference] User prefers short responses (confidence: 0.8)"`
   - After: `"APPLY: Keep responses short and direct — confirmed preference (confidence: 0.8, reinforced 5x)"`
4. Cap at 8 lessons + 3 rules to avoid context bloat

### 1C. Wire Task Outcomes → Lesson Reinforcement

**Problem**: When a task completes/fails, the `task-poller` sends a notification but doesn't reinforce or penalize the lessons that were in context.

**File**: `eliza/src/plugins/itachi-tasks/services/task-poller.ts`

**New flow** (add to task completion handler):
1. On task completion: fetch the task's `description` (which has `--- Lessons from previous tasks ---` appended by `enrichWithLessons()`)
2. Parse the lesson IDs/summaries that were injected
3. If task succeeded: `memoryService.reinforceMemory(lessonId)` — bumps confidence + reinforcement count
4. If task failed: store new anti-lesson with `outcome: 'failure'` and reference to the failing lesson

### 1D. Bidirectional Local Session Flow

**Problem**: Local Claude Code sessions read rules (via session-start hook → MEMORY.md) but local discoveries don't flow back as lessons.

**Changes**:

1. **session-end hook enhancement** (`hooks/unix/session-end.sh`, `hooks/windows/session-end.ps1`):
   - After calling `/api/session/extract-insights`, also call a NEW endpoint:
   - `POST /api/session/contribute-lessons` — takes the conversation transcript and explicitly stores high-value insights as `category: 'task_lesson'`

2. **New endpoint** in code-intel-routes: `POST /api/session/contribute-lessons`
   - Takes: `conversation_text`, `project`, `task_id` (optional)
   - LLM extracts lessons using same prompt as `lessonExtractor` but tuned for local sessions
   - Stores directly as `category: 'task_lesson'` with `metadata.source: 'local_session'`
   - Returns count of lessons stored

3. **Real-time `/learn` command** — new action in itachi-tasks:
   - User types `/learn itachi-memory always run build before pushing` in Telegram
   - Stores as `category: 'project_rule'` with `confidence: 0.95` (explicit user instruction)
   - Immediate effect: next session-start hook picks it up via `/api/project/learnings`

---

## Phase 2: Personality Evolution (Week 2-3)

**Goal**: Bot learns and reflects the user's communication style.

### 2A. Personality Extractor Evaluator

**New file**: `eliza/src/plugins/itachi-self-improve/evaluators/personality-extractor.ts`

**Triggers**: On user Telegram messages (similar to `conversationMemoryEvaluator`, but focused on style)

**Extracts** (via LLM, runs every ~10 messages to avoid cost):
- `communication_tone`: formal/casual/terse/verbose/technical
- `decision_style`: cautious/bold, collaborative/autonomous, data-driven/intuitive
- `priority_signals`: what the user cares about (speed, quality, cost, learning)
- `vocabulary_patterns`: words/phrases the user frequently uses
- `approval_patterns`: what gets praise vs criticism

**Storage**: `category: 'personality_trait'` in `itachi_memories` with dedup (similarity > 0.9 → reinforce)

### 2B. Dynamic Personality Provider

**New file**: `eliza/src/plugins/itachi-self-improve/providers/personality.ts`

**Position**: 3 (very early — shapes ALL responses)

**What it does**:
1. Loads personality traits from `itachi_memories` (top 10 by confidence × reinforcement)
2. Loads identity facts from `factsContextProvider` (already exists)
3. Compiles into a personality directive:
```
## Your Personality (learned from user interactions)
Communication: Direct and casual. Use technical terms freely. Keep it short.
Decision style: Bold — user prefers action over analysis. Bias toward "just do it."
Priorities: Speed > cost > perfection. Ship fast, iterate later.
Vocabulary: User says "ship it", "merge and push", "just fix it." Mirror this tone.
```
4. Updates as new traits are extracted — personality evolves over time

### 2C. `/teach` Command

**File**: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts` (add handler)

**Syntax**: `/teach <instruction>`
- `/teach I prefer seeing diffs before you commit`
- `/teach always create PRs for itachi-memory, never push directly`
- `/teach my communication style is casual and direct`

**Storage**:
- If instruction mentions a project → `category: 'project_rule'` with `confidence: 0.95`
- If instruction is about communication/personality → `category: 'personality_trait'` with `confidence: 0.95`
- If instruction is about workflow → `category: 'task_lesson'` with `lesson_category: 'user-preference'`

### 2D. Local Session Personality Contribution

**File**: `eliza/src/plugins/itachi-code-intel/workers/style-extractor.ts`

**Current**: Extracts code style (naming, formatting, etc.) weekly. Missing: communication style.

**Enhancement**: Add a second LLM pass that analyzes session transcripts for communication patterns:
- How does the user phrase requests?
- What gets corrected vs approved?
- Preferred level of detail in explanations
- Store as personality traits alongside code style

---

## Phase 3: Active RLM — Decisions Shaped by Lessons (Week 3-4)

**Goal**: Lessons don't just inform — they prescribe actions.

### 3A. Reward Signal System

**New file**: `eliza/src/plugins/itachi-self-improve/services/rlm-service.ts`

**RLMService** (registered as service `'rlm'`):
- `recordOutcome(taskId, outcome: 'success' | 'failure' | 'partial', score: number)` — stores in new `lesson_applications` tracking
- `reinforceLessonsForTask(taskId)` — finds lessons that were in context when task was created, adjusts confidence
- `getRecommendations(project, description)` — returns actionable recommendations:
  - Suggested budget (based on similar task outcomes)
  - Suggested model (based on task complexity + past model performance)
  - Suggested machine (based on project affinity + machine health)
  - Warnings (based on past failures with similar descriptions)

### 3B. Decision Shaping in Task Creation

**File**: `eliza/src/plugins/itachi-tasks/actions/create-task.ts`

**Enhancement**: Before creating a task, consult RLMService:
```typescript
const rlm = runtime.getService<RLMService>('rlm');
if (rlm) {
  const recs = await rlm.getRecommendations(project, description);
  if (recs.suggestedBudget) params.max_budget_usd = recs.suggestedBudget;
  if (recs.suggestedModel) params.model = recs.suggestedModel;
  if (recs.warnings.length > 0) {
    // Include warnings in callback
    callbackText += `\n\nHeads up: ${recs.warnings.join('; ')}`;
  }
}
```

### 3C. Feedback → Reinforcement Loop

**File**: `telegram-commands.ts` (handleFeedback)

**Current**: `/feedback <id> good/bad <reason>` stores a memory. Disconnected from lessons.

**Enhancement**:
1. On good feedback: find lessons that were in task context → `reinforceMemory()` each
2. On bad feedback: find lessons → reduce confidence (`confidence *= 0.8`)
3. Store outcome in `lesson_applications` for effectiveness tracking

### 3D. Lesson Effectiveness Decay

**New worker** in `itachi-self-improve/workers/`:
- Weekly: scan all `task_lesson` memories
- For each: check `lesson_applications` — how many times applied, success rate
- If applied 5+ times with < 30% success → reduce confidence to 0.1 (effectively deprioritize)
- If applied 5+ times with > 80% success → boost confidence to 0.95
- Log report as strategy_document

---

## Phase 4: Subagent Orchestration (Week 4-5)

**Goal**: Clear UX for spawning specialized agents, shared learning.

### 4A. Telegram Subagent Commands

**File**: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts` (extend)

New commands:
- `/spawn <profile> <task>` — spawn a subagent (e.g., `/spawn code-reviewer review PR #5 on itachi-memory`)
- `/agents` — list active subagent runs
- `/msg <agent-id> <message>` — send message to running agent

These call into existing `SubagentService` methods. The plumbing exists; the UX doesn't.

### 4B. Auto-Delegation

**File**: `eliza/src/plugins/itachi-tasks/actions/create-task.ts`

When creating a task, check if a specialized agent profile matches:
- `code-reviewer` → tasks with "review", "audit", "check"
- `researcher` → tasks with "investigate", "explore", "find"
- `devops` → tasks with "deploy", "configure", "setup"

If match found AND agent has good success_rate → offer delegation:
"I can delegate this to the code-reviewer agent (85% success rate). Proceed?"

### 4C. Cross-Agent Lesson Sharing

**File**: `eliza/src/plugins/itachi-agents/evaluators/subagent-lesson.ts`

**Current**: Extracts lessons into agent's own `memory_namespace:lesson` category. Isolated.

**Enhancement**: Store a COPY in the shared `task_lesson` category (with `metadata.source_agent: profileId`). This way:
- Main bot sees subagent discoveries via `lessonsProvider`
- Other subagents benefit from shared lessons
- Reflection worker synthesizes across all agents

---

## File Impact Summary

| Phase | File | Change |
|-------|------|--------|
| 1A | `itachi-code-intel/routes/code-intel-routes.ts` | Store insights as `task_lesson` category |
| 1B | `itachi-self-improve/providers/lessons.ts` | Multi-category search, weighted ranking, directive format |
| 1C | `itachi-tasks/services/task-poller.ts` | Reinforce lessons on task completion |
| 1D | `hooks/unix/session-end.sh` + `hooks/windows/session-end.ps1` | Call contribute-lessons endpoint |
| 1D | `itachi-code-intel/routes/code-intel-routes.ts` | New `/api/session/contribute-lessons` endpoint |
| 1D | `itachi-tasks/actions/telegram-commands.ts` | Add `/learn` command handler |
| 2A | NEW: `itachi-self-improve/evaluators/personality-extractor.ts` | Extract personality from messages |
| 2B | NEW: `itachi-self-improve/providers/personality.ts` | Dynamic personality injection |
| 2C | `itachi-tasks/actions/telegram-commands.ts` | Add `/teach` command handler |
| 2D | `itachi-code-intel/workers/style-extractor.ts` | Add communication style extraction |
| 3A | NEW: `itachi-self-improve/services/rlm-service.ts` | Reward signals, recommendations |
| 3B | `itachi-tasks/actions/create-task.ts` | Consult RLM for task params |
| 3C | `itachi-tasks/actions/telegram-commands.ts` | Wire feedback → lesson reinforcement |
| 3D | NEW: `itachi-self-improve/workers/effectiveness-worker.ts` | Lesson confidence decay/boost |
| 4A | `itachi-tasks/actions/telegram-commands.ts` | `/spawn`, `/agents`, `/msg` commands |
| 4B | `itachi-tasks/actions/create-task.ts` | Auto-delegation to matching profiles |
| 4C | `itachi-agents/evaluators/subagent-lesson.ts` | Cross-agent lesson sharing |

---

## Implementation Order (Dependency Chain)

```
Phase 1A (fix RLM bridge) ──→ Phase 1B (upgrade lessonsProvider)
                                  ↓
Phase 1D (/learn + contribute)    Phase 1C (task outcome reinforcement)
         ↓                            ↓
Phase 2A (personality extractor) ──→ Phase 2B (personality provider)
         ↓
Phase 2C (/teach command)         Phase 2D (style extractor upgrade)
         ↓
Phase 3A (RLM service)  ──→ Phase 3B (decision shaping)
                              ↓
Phase 3C (feedback loop) ──→ Phase 3D (effectiveness worker)
         ↓
Phase 4A (subagent commands) ──→ Phase 4B (auto-delegation)
                                     ↓
                              Phase 4C (cross-agent sharing)
```

**Critical path**: 1A → 1B → 2A → 2B (everything else can be parallelized).

---

## Verification

### Phase 1 Criteria
- Run a local Claude Code session → end session → check `itachi_memories` for `category: task_lesson` with `source: 'local_session'`
- Send a Telegram message → check that `lessonsProvider` returns both task_lessons AND project_rules
- Complete a task → verify lessons in context got `reinforceMemory()` called
- `/learn always use bun for testing` → verify stored as project_rule → appears in next session's MEMORY.md

### Phase 2 Criteria
- After 10+ Telegram messages → check `itachi_memories` for `category: personality_trait`
- Send a message → verify personality provider injects personality directive at position 3
- `/teach I prefer casual tone` → verify immediate personality trait storage
- Bot responses start reflecting learned personality within ~20 messages

### Phase 3 Criteria
- Create task → verify RLM recommendations in callback (budget/warnings)
- `/feedback <id> good reason` → verify related lessons get confidence bump
- Weekly: effectiveness worker runs → low-performing lessons deprioritized

### Phase 4 Criteria
- `/spawn code-reviewer review PR #5` → subagent run created, status shown
- `/agents` → lists active runs with status
- Subagent completes → lesson appears in shared `task_lesson` pool
