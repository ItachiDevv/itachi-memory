# RLM + Eliza Master Plan (Detailed)

## Purpose

This document defines a full implementation plan for adding an outcome-driven Recursive Learning Model (RLM) loop to scan analysis quality, with Eliza as the orchestration/runtime layer.

It is written for two contexts:
- **Itachi-memory** (current implementation base with Eliza plugins and existing management-focused RLM loop)
- **Gudtek** (target scan product that analyzes GitHub repositories and produces legitimacy scores)

---

## 1. Current Baseline in Itachi

### What exists now

- Eliza runtime and plugin composition:
  - `eliza/src/index.ts`
- Code-intel pipeline:
  - `eliza/src/plugins/itachi-code-intel/`
- Existing RLM loop:
  - evaluator: `eliza/src/plugins/itachi-self-improve/evaluators/lesson-extractor.ts`
  - provider: `eliza/src/plugins/itachi-self-improve/providers/lessons.ts`
  - reflection worker: `eliza/src/plugins/itachi-self-improve/workers/reflection-worker.ts`
- Session insight bridge into RLM:
  - route: `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts`
  - endpoint: `POST /api/session/extract-insights`

### Critical gap

Current RLM behavior is mostly management-lesson oriented:
- task estimation
- project selection behavior
- user preferences

Missing quality loop:
- no structured per-finding outcome labels
- no reward function tied to scan quality
- no model-routing adaptation based on measured scan performance
- no metrics-gated rollout for prompt/routing strategy changes

---

## 2. Target Architecture

### Design Goal

Transform scan analysis from a one-shot score generation pipeline into a closed feedback system:

1. **Analyze**
2. **Observe outcomes**
3. **Learn lessons**
4. **Inject lessons into future analysis**
5. **Route models by measured quality**
6. **Validate improvement with metrics before rollout**

### Architecture Diagram

```mermaid
flowchart TD
  A[Scan trigger: hook/orchestrator/API/UI] --> B[Scan Analyze Route]
  B --> C[ScanAnalysisService]
  C --> D[ScanModelRouter]
  D -->|Primary route| E1[Gemini via Eliza model plugin]
  D -->|Fallback route| E2[Anthropic/OpenAI via Eliza model plugins]
  E1 --> F[Findings + confidence + rationale + score]
  E2 --> F

  F --> G[(scan_analysis_events)]
  F --> H[Outcome Route]
  H --> I[(scan_finding_outcomes)]

  I --> J[scan-outcome evaluator]
  J --> K[(Eliza CUSTOM memories: scan-model-lesson)]
  K --> L[scan-lessons provider]
  L --> C

  K --> M[scan reflection worker]
  M --> N[(Eliza CUSTOM memories: scan-strategy-document)]
  N --> D

  O[metrics endpoint] --> P[precision@k, FPR, fix-rate, drift]
  P --> D
  P --> Q[rollout gate]
```

---

## 3. Domain Model

### 3.1 Entities

- `ScanAnalysisEvent`
  - one analysis run for one target (repo, session, or artifact)
- `ScanFinding`
  - one predicted issue/observation from analysis
- `ScanOutcome`
  - human or system feedback attached to a finding
- `ScanModelLesson`
  - distilled learning from outcomes
- `ScanStrategyDocument`
  - synthesized weekly policy/routing guidance

### 3.2 Recommended Tables

#### `scan_analysis_events`
- `id uuid pk`
  - event identity
- `project text`
  - logical project
- `target_id text`
  - repo/session identifier
- `scanner text`
  - source scanner (`gudtek_phase1`, `itachi_extract_insights`, etc.)
- `model_provider text`
  - `google`, `anthropic`, `openai`
- `model_name text`
  - exact model identifier
- `prompt_version text`
  - immutable prompt spec version
- `strategy_version text`
  - active strategy document/version
- `input_features jsonb`
  - tokenized context features / heuristics
- `findings jsonb`
  - structured finding list with IDs/confidence
- `score numeric`
  - aggregate score if applicable
- `created_at timestamptz`

#### `scan_finding_outcomes`
- `id uuid pk`
- `analysis_event_id uuid fk`
- `finding_key text`
  - deterministic per-finding identity
- `label text`
  - `accepted`, `rejected_fp`, `fixed`, `reopened`, `ignored`
- `reward numeric`
  - normalized scalar signal
- `source text`
  - `user`, `rule`, `post-merge-check`, `test-pipeline`
- `notes text`
- `created_at timestamptz`

#### Optional rollups
- materialized daily rollup by:
  - project
  - model_provider/model_name
  - scanner
  - prompt_version
  - strategy_version

---

## 4. Reward System

### 4.1 Label -> Reward mapping (initial)

- `fixed` = `+1.00`
- `accepted` (not fixed yet) = `+0.50`
- `ignored` = `0.00`
- `rejected_fp` = `-0.70`
- `reopened` = `-1.00`

### 4.2 Why this shape

- penalizes false positives and regressions more strongly than neutral/unknown outcomes
- keeps reward bounded to simplify aggregation and drift tracking
- gives partial credit for accepted-but-unresolved findings

### 4.3 Future extension

Add confidence calibration reward:
- if high-confidence finding repeatedly rejected, apply extra penalty
- if low-confidence finding fixed, apply extra positive adjustment

---

## 5. Eliza Component Design

### 5.1 New services (code-intel)

- `ScanAnalysisService`
  - input normalization
  - prompt assembly
  - finding extraction and deterministic `finding_key` creation
  - event persistence
- `ScanModelRouter`
  - selects model by scan type, project profile, recent metrics
  - fallback chain support

### 5.2 New routes

- `POST /api/scan/analyze`
  - executes routed model analysis
  - stores `scan_analysis_events`
- `POST /api/scan/outcome`
  - stores labeled outcomes and reward
- `GET /api/scan/metrics`
  - exposes quality trend metrics

### 5.3 New RLM evaluator (self-improve)

- `scan-outcome-extractor.ts`
  - transforms outcome windows into reusable lessons
  - writes `MemoryType.CUSTOM` with `metadata.type = "scan-model-lesson"`

### 5.4 New provider

- `scan-lessons.ts`
  - injects top ranked relevant lessons into analysis context
  - rank formula:
    - `semantic_similarity * confidence * abs(avg_reward) * freshness_decay`
  - token budget cap is mandatory

### 5.5 New reflection worker

- `scan-reflection-worker.ts`
  - weekly synthesis of lessons into strategy docs
  - max 4 active strategy docs
  - emits recommended router/prompt changes and rollback conditions

---

## 6. Metrics Framework

### 6.1 Primary metrics

- `precision@k` for high-confidence findings
- false-positive rate (`rejected_fp / total_labeled`)
- accepted-to-fixed conversion
- reopened rate
- median time-to-fix

### 6.2 Secondary metrics

- confidence calibration error
- per-model quality deltas
- per-project drift (7-day and 28-day windows)

### 6.3 Rollout policy

No strategy activation without:
- sufficient sample size
- non-regression on false-positive rate
- net positive quality delta (threshold configurable)

---

## 7. Phase Overview

Detailed execution docs:
- Phase 0 (Instrumentation): `docs/rlm-phase-0-detailed.md`
- Phase 1 (Reward + Evaluator): `docs/rlm-phase-1-detailed.md`

High-level sequence:
- Phase 0: event and outcome plumbing
- Phase 1: reward mapping + lesson generation
- Phase 2: lesson injection provider
- Phase 3: reflection synthesis and strategy docs
- Phase 4: adaptive model routing
- Phase 5: metrics-gated production rollout

---

## 8. Risk Register

### 8.1 Data quality risk
- weak labels can poison lessons
- mitigation:
  - source confidence in metadata
  - minimum label quality gate

### 8.2 Prompt bloat risk
- too many lessons degrade model output
- mitigation:
  - strict top-K + token budget
  - decay stale lessons

### 8.3 Routing instability risk
- overreactive model switching
- mitigation:
  - smoothing windows
  - hysteresis thresholds
  - canary-only rollout first

### 8.4 Overfitting to one project
- mitigation:
  - project-scoped defaults
  - cross-project promotion only with measured lift

---

## 9. External References

- Eliza plugin architecture:
  - https://docs.eliza.how/plugins/architecture
- Eliza services/tasks:
  - https://docs.eliza.how/plugins/services
- Eliza repository:
  - https://github.com/elizaOS/eliza
- Eliza Gemini plugin:
  - https://www.npmjs.com/package/@elizaos/plugin-google-genai
- Reflexion:
  - https://arxiv.org/abs/2303.11366
- Self-Refine:
  - https://arxiv.org/abs/2303.17651
- Generative Agents:
  - https://arxiv.org/abs/2304.03442
- SWE-bench:
  - https://arxiv.org/abs/2310.06770
