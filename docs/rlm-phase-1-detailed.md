# RLM Phase 1 (Detailed): Reward Mapping + Lesson Extraction

## Objective

Convert labeled scan outcomes into durable, high-signal lessons that can later improve analysis quality.

Phase 1 introduces learning artifacts but does not yet auto-inject them into prompts.

---

## 1. Scope

### In scope

- reward computation from labels
- scan-outcome evaluator
- storage of `scan-model-lesson` memories
- initial quality sanity checks

### Out of scope

- lesson injection provider (Phase 2)
- weekly strategy synthesis worker (Phase 3)
- adaptive routing (Phase 4)

---

## 2. Deliverables

1. Reward mapping utility in self-improve module.
2. New evaluator:
   - `scan-outcome-extractor.ts`
3. Memory write format:
   - `MemoryType.CUSTOM`
   - `metadata.type = "scan-model-lesson"`
4. Test coverage:
   - reward mapping
   - evaluator parse/validation
   - write guardrails

---

## 3. Reward Model

## 3.1 Base mapping

- `fixed` => `+1.00`
- `accepted` => `+0.50`
- `ignored` => `0.00`
- `rejected_fp` => `-0.70`
- `reopened` => `-1.00`

## 3.2 Optional confidence weighting

When confidence is available:

```
weighted_reward = base_reward * (0.5 + 0.5 * confidence)
```

Rationale:
- high-confidence misses get stronger penalty
- high-confidence true positives get stronger reward

## 3.3 Aggregation window

Initial lesson extraction window:
- last 7 days
- grouped by:
  - `project`
  - `scanner`
  - `model_provider/model_name`
  - optional finding category

---

## 4. Evaluator Design

### 4.1 Trigger policy

Evaluator runs when:
- new outcome rows are ingested, or
- periodic poll sees unlabeled-outcome deltas

### 4.2 Input bundle

For each grouping key:
- set of findings + labels + rewards
- analysis context slices (prompt version, strategy version)
- optional excerpts from finding summaries

### 4.3 Output lessons

Lesson categories:
- `signal-quality`
- `false-positive-pattern`
- `remediation-effectiveness`
- `repo-context-gap`
- `model-routing`

Example lesson text:
- `"For TypeScript monorepos with high test coverage, dependency-version red flags are often false positives unless combined with maintainer privilege anomalies."`

---

## 5. Memory Storage Contract

Each stored lesson should include:

- `type: MemoryType.CUSTOM`
- `content.text`: concise reusable lesson
- `metadata`:
  - `type: "scan-model-lesson"`
  - `category`
  - `confidence`
  - `avg_reward`
  - `sample_size`
  - `project`
  - `scanner`
  - `model_provider`
  - `model_name`
  - `prompt_version`
  - `strategy_version`
  - `window_start`
  - `window_end`
  - `created_from: "scan_finding_outcomes"`

Guardrails:
- reject lesson if sample size < minimum threshold
- reject lesson confidence below threshold
- dedupe near-duplicate lesson text by semantic match before insert

---

## 6. Suggested File Changes

- `eliza/src/plugins/itachi-self-improve/evaluators/scan-outcome-extractor.ts`
  - new evaluator
- `eliza/src/plugins/itachi-self-improve/index.ts`
  - register evaluator export
- `eliza/src/index.ts`
  - ensure evaluator is active in plugin assembly
- optional helper:
  - `eliza/src/plugins/itachi-self-improve/services/scan-reward.ts`

---

## 7. Pseudocode

```typescript
for each grouping in outcomeWindow:
  const scored = outcomes.map(o => ({
    ...o,
    reward: mapLabelToReward(o.label, o.confidence)
  }))

  if (scored.length < MIN_SAMPLE) continue

  const prompt = buildLessonExtractionPrompt(scored, analysisContext)
  const llm = runtime.useModel(ModelType.TEXT_SMALL, { prompt, temperature: 0.2 })
  const lessons = parseLessons(llm)

  for lesson in lessons:
    if (lesson.confidence < 0.55) continue
    if (isDuplicateLesson(lesson)) continue

    runtime.createMemory({
      type: MemoryType.CUSTOM,
      content: { text: lesson.text },
      metadata: {
        type: "scan-model-lesson",
        category: lesson.category,
        confidence: lesson.confidence,
        avg_reward: avg(scored.rewards),
        sample_size: scored.length,
        ...
      }
    })
```

---

## 8. Testing Plan

## 8.1 Unit tests

- label to reward mapping
- confidence-weighted reward boundaries
- invalid label handling

## 8.2 Evaluator tests

- parse valid JSON lesson output
- reject malformed output safely
- skip low-confidence / low-sample lessons
- ensure metadata fields are always present

## 8.3 Regression tests

- existing management lesson evaluator still works
- no unexpected changes in existing self-improve provider output

---

## 9. Quality Gates

Phase 1 completes when:

1. Outcome labels reliably produce reward values.
2. Evaluator stores high-quality `scan-model-lesson` memories.
3. Duplicate/noisy lessons are filtered.
4. Tests pass for mapping, extraction, and storage contracts.

---

## 10. Gudtek Application Notes

Gudtek has ideal inputs for Phase 1:
- `analysis_history` append-only snapshots
- `analysis_cache` current scan state
- rich score fields:
  - `legitimacy_score`
  - `red_flags`
  - `security_risks`
  - `timeline_red_flags`
  - `copy_likelihood_score`
  - `complexity_score`

Recommended immediate labels in Gudtek:
- reviewer marks finding as false positive
- token later added to wall-of-shame after high score (strong negative signal)
- repeated rescans shift score after code changes (signal for previous finding accuracy)

These can feed the same reward and lesson pipeline with minimal schema bridge.
