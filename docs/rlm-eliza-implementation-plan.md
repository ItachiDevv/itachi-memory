# RLM + Eliza Implementation Plan for Scan Modeling

## 1. Current-State Audit (from this repo)

You already have Eliza integrated and running:
- runtime + plugin wiring in `eliza/src/index.ts`
- scan/intel pipeline in `eliza/src/plugins/itachi-code-intel/`
- existing RLM loop in `eliza/src/plugins/itachi-self-improve/`

You also already bridge session insights into RLM:
- `/api/session/extract-insights` in `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts`

Important gap:
- The current RLM learns management behavior.
- It does not yet learn scan-model quality over time (false positives, acceptance rate, remediation success, model-specific quality drift).

Important note about Gemini:
- In this repo, Gemini is currently present as an install credential (`install.mjs`) and skill docs, but not as an active Eliza model plugin in `eliza/src/character.ts`.

## 2. Target Outcome

Add a closed-loop scan-learning system:
1. Record each scan analysis event (prompt/model/features/output).
2. Record downstream outcomes (accepted/rejected/fixed/reopened).
3. Convert outcomes into reusable RLM lessons.
4. Inject lessons into future scan analyses.
5. Route models using empirical quality history.
6. Measure trend deltas and gate rollouts by metrics.

## 3. Architecture Diagram

```mermaid
flowchart TD
    A[Hooks / Orchestrator / API client] --> B[POST /api/scan/analyze]
    B --> C[itachi-code-intel ScanAnalysisService]
    C --> D[Model Router]
    D -->|Gemini| E1[Eliza Google GenAI plugin]
    D -->|Anthropic/OpenAI fallback| E2[Eliza model plugins]
    E1 --> F[Findings + confidence + rationale]
    E2 --> F

    F --> G[(scan_analysis_events)]
    F --> H[POST /api/scan/outcome]
    H --> I[(scan_finding_outcomes)]

    I --> J[scan-outcome-extractor evaluator]
    J --> K[(Eliza memories CUSTOM: scan-model-lesson)]
    K --> L[scan-lessons provider]
    L --> C

    K --> M[scan-reflection-worker]
    M --> N[(Eliza memories CUSTOM: scan-strategy-document)]
    N --> D

    O[GET /api/scan/metrics] --> P[precision@k / FP rate / fix-rate]
    P --> D
```

## 4. Data Model Additions

Add a new migration in `supabase/migrations/`:

- `scan_analysis_events`
  - `id`, `project`, `session_id`, `scanner`, `model_provider`, `model_name`
  - `prompt_version`, `strategy_version`, `input_features jsonb`
  - `findings jsonb`, `created_at`

- `scan_finding_outcomes`
  - `id`, `analysis_event_id`, `finding_key`, `label`
  - labels: `accepted`, `rejected_fp`, `fixed`, `reopened`, `ignored`
  - `reward numeric`, `source`, `created_at`

- optional view/materialized view for daily rollups by model/scanner/project.

## 5. Implementation Phases

### Phase 0: Instrumentation Baseline (1-2 days)

- Add `POST /api/scan/analyze` and `POST /api/scan/outcome`.
- Persist analysis events and outcomes.
- Add deterministic `finding_key` generation.

Acceptance:
- Every scan output can be joined to at least one outcome row.

### Phase 1: Reward Model + Evaluator (1 day)

- Add reward mapping in code (for example `accepted=+0.5`, `fixed=+1.0`, `rejected_fp=-0.7`, `reopened=-1.0`).
- Create `scan-outcome-extractor` evaluator in `itachi-self-improve/evaluators/`.
- Store lessons as `MemoryType.CUSTOM` with `metadata.type = "scan-model-lesson"`.

Acceptance:
- Lessons are created only for validated outcomes.

### Phase 2: Lesson Injection Provider (1 day)

- Add `scan-lessons` provider (or extend `lessonsProvider`) to inject top-K relevant lessons.
- Rank with weighted score:
  - `semantic_similarity * confidence * abs(avg_reward) * freshness_decay`
- Cap to a fixed token budget.

Acceptance:
- Scan prompts include concise, high-signal lessons.

### Phase 3: Reflection + Strategy Docs (1 day)

- Add `scan-reflection-worker` (weekly or daily initially).
- Synthesize lessons into `scan-strategy-document`.
- Keep max 4 active strategy docs and retire stale ones.

Acceptance:
- Strategy docs are generated and consumed by router/provider.

### Phase 4: Model Routing (1-2 days)

- Add `ScanModelRouter` service in `itachi-code-intel/services/`.
- Choose model by scan type + repo + recent quality metrics.
- Integrate Gemini via `@elizaos/plugin-google-genai` while preserving fallback providers.

Acceptance:
- Routing decisions are logged with reason and metric basis.

### Phase 5: Evaluation and Rollout Gates (1 day)

- Add `GET /api/scan/metrics` for:
  - precision@k
  - false-positive rate
  - accepted-to-fixed conversion rate
  - median time-to-fix
- Run shadow mode for at least 2 weeks of data.
- Enable only if baseline delta passes threshold.

Acceptance:
- Release is metrics-gated, not intuition-gated.

## 6. File-Level Change Plan

- `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts`
  - add scan routes and metric endpoint.
- `eliza/src/plugins/itachi-code-intel/services/`
  - add `scan-analysis-service.ts`, `scan-model-router.ts`.
- `eliza/src/plugins/itachi-self-improve/evaluators/`
  - add `scan-outcome-extractor.ts`.
- `eliza/src/plugins/itachi-self-improve/providers/`
  - add `scan-lessons.ts`.
- `eliza/src/plugins/itachi-self-improve/workers/`
  - add `scan-reflection-worker.ts`.
- `eliza/src/plugins/itachi-self-improve/index.ts`
  - register evaluator/provider/worker exports.
- `eliza/src/index.ts`
  - register new worker task.
- `supabase/migrations/*`
  - add scan event/outcome schema migration.

## 7. Guardrails

- No lesson write without a corresponding outcome label.
- No strategy activation if precision@k regresses.
- Keep project-scoped lessons by default; promote cross-project only with evidence.
- Track `prompt_version` and `strategy_version` on each analysis event.
- Add rollback toggle for router strategy.

## 8. External Basis for This Plan

- Eliza plugin architecture and service/task patterns:
  - https://docs.eliza.how/plugins/architecture
  - https://docs.eliza.how/plugins/services
- Gemini plugin in Eliza:
  - https://www.npmjs.com/package/@elizaos/plugin-google-genai
- Learning-loop papers used for design choices:
  - Reflexion: https://arxiv.org/abs/2303.11366
  - Self-Refine: https://arxiv.org/abs/2303.17651
  - Generative Agents memory weighting: https://arxiv.org/abs/2304.03442
  - SWE-bench eval framing: https://arxiv.org/abs/2310.06770
