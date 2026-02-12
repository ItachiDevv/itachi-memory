# Itachi Integration Points for RLM Modeling

## Current State (Already in Repo)

- Eliza runtime and plugins are active in `eliza/src/index.ts`.
- Code analysis pipeline exists in `eliza/src/plugins/itachi-code-intel/`.
- Current RLM loop exists in `eliza/src/plugins/itachi-self-improve/`:
  - evaluator: `evaluators/lesson-extractor.ts`
  - provider: `providers/lessons.ts`
  - weekly synthesis: `workers/reflection-worker.ts`
- Session insight bridge exists in `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts` (`/api/session/extract-insights`).
- Project rules reinforcement exists through `MemoryService.reinforceMemory` and `updateMemorySummary`.

## Observed Gap for "Scan Modeling"

The current loop mostly learns management behavior (task estimation, user preference, error handling), not model-quality behavior for scan findings.

Missing dedicated pieces:
- structured scan-analysis event log (input prompt/model/features/output)
- outcome labels tied to each finding (accepted/rejected/fixed/reopened)
- reward computation and trend tracking
- model-routing feedback based on observed scan quality

## Suggested Extension Points

### New or Extended Route Layer

Prefer adding in `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts`:
- `POST /api/scan/analyze` (if scans are initiated here)
- `POST /api/scan/outcome` (record label + reward inputs)
- `GET /api/scan/metrics` (precision/FP drift)

### New Evaluator

Add under `eliza/src/plugins/itachi-self-improve/evaluators/`:
- `scan-outcome-extractor.ts`
- emits `MemoryType.CUSTOM` with `metadata.type = "scan-model-lesson"`

### New Provider

Add under `eliza/src/plugins/itachi-self-improve/providers/`:
- `scan-lessons.ts`
- injected early when handling scan analysis flows

### New Worker

Add under `eliza/src/plugins/itachi-self-improve/workers/`:
- `scan-reflection-worker.ts` (weekly or daily)
- synthesizes lesson windows into strategy documents and routing recommendations

### Schema

Add migration under `supabase/migrations/` for:
- `scan_analysis_events`
- `scan_finding_outcomes`
- optional materialized metrics view for daily/weekly quality rollups

## Practical Model-Routing Hook

Where model routing is needed:
- add a small `ScanModelRouter` service in `itachi-code-intel/services/`
- use strategy docs + recent metrics to select provider/model per scan type
- keep fallback chain explicit (for example Gemini -> Anthropic -> OpenAI)
