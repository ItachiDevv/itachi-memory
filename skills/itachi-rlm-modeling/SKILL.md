---
name: itachi-rlm-modeling
description: >
  Agent skill: build and operate an RLM loop for code scan analysis quality in
  Itachi/Eliza systems and Gudtek-style GitHub scoring pipelines.
  Use when improving scan prompts, model routing (Gemini/Anthropic/OpenAI), confidence
  calibration, false-positive reduction, or learning from scan outcomes over time.
---

# Itachi RLM Modeling (Agent Skill)

Use this skill when the user wants to improve how code scans are analyzed over time, not just store scan artifacts.

## Scope

This skill targets:
- `eliza/src/plugins/itachi-code-intel/*` (scan extraction + routes + workers)
- `eliza/src/plugins/itachi-self-improve/*` (RLM memory loop)
- `supabase/migrations/*` (evaluation/event storage)
- `hooks/*` and `orchestrator/*` (scan/outcome signal feed)

Read these first:
- `references/itachi-integration-points.md`
- `references/external-research.md`
- `../../docs/rlm-eliza-master-plan-detailed.md`
- `../../docs/rlm-phase-0-detailed.md`
- `../../docs/rlm-phase-1-detailed.md`
- `../../docs/gudtek-rlm-eliza-implementation-analysis.md`

## Core Principle

Treat scan analysis as a closed loop:
1. Generate scan insights.
2. Observe outcome signals.
3. Convert outcomes into lessons.
4. Inject lessons into the next analysis pass.
5. Measure whether quality improved.

No RLM change is complete unless metrics improve on a held-out window.

## Required Inputs

Collect before making changes:
- Scan source: hook transcript, diff analyzer, external scanner, or manual review.
- Outcome labels: accepted/rejected finding, fix merged/reverted, test pass/fail, user correction.
- Time window: at least 14 days for trend comparison.
- Target metric: precision@k, false-positive rate, rule adoption rate, or time-to-fix.

## Implementation Workflow

### 1) Instrument events and outcomes

Add or verify durable records for:
- analysis request (prompt, model, context features)
- model output (findings, confidence, rationale, categories)
- downstream outcome (accepted/rejected/fixed/reopened)

Use append-only events where possible.

Execution target files:
- `eliza/src/plugins/itachi-code-intel/routes/code-intel-routes.ts`
- `supabase/migrations/*`
- Gudtek equivalent: `app/api/github-legitimacy/route.ts`, `app/api/developer-code-analysis/route.ts`

### 2) Define reward signals

Build a normalized score per finding in [-1, 1]:
- +1.0 accepted and fixed
- +0.5 accepted, no fix yet
- -0.7 rejected as false positive
- -1.0 caused regression/noise

Store both raw labels and derived reward.

Execution target files:
- `eliza/src/plugins/itachi-self-improve/evaluators/*`
- Gudtek equivalent: `lib/scanReward.ts` (new), route handlers posting outcomes

### 3) Extract RLM lessons from outcomes

Create lessons that are reusable, not case-specific:
- `signal-quality`: what evidence predicts true positives
- `false-positive-pattern`: recurring bad patterns
- `repo-context-gap`: missing project context
- `remediation-effectiveness`: what fixes worked
- `model-routing`: when Gemini vs Anthropic vs OpenAI performs better

Save as Eliza `MemoryType.CUSTOM` with metadata:
- `type: "scan-model-lesson"`
- `confidence`
- `reward`
- `window_start`, `window_end`
- `project`, `scanner`, `model`

If implementing for Gudtek:
- either write lessons into Eliza sidecar memories, or
- mirror lesson artifacts in Gudtek tables with equivalent metadata.

### 4) Inject lessons into analysis

Add a provider (or extend existing providers) that injects top lessons before scan analysis.

Ranking formula:
- score = semantic_similarity * confidence * abs(avg_reward) * freshness_decay

Hard cap context payload to prevent prompt bloat.

For Gudtek prompt integration:
- inject lessons into `lib/geminiRepoAnalyzer.ts` prompt assembly only after shadow validation.

### 5) Add reflection synthesis

Add a weekly worker to synthesize lessons into strategy docs:
- keep max 4 active strategy docs
- emit specific routing/prompt updates
- include rollback criteria if quality drops

### 6) Add rollout gates

Before enabling globally:
- run shadow mode (new strategy logs only)
- compare against baseline on same traffic
- require metric improvement threshold (for example +10% precision@k)

Never bypass rollout gates for production score-impacting changes.

### 7) Verify with tests

At minimum:
- unit test for reward mapping
- evaluator parse/validation tests
- provider ranking tests
- regression test for route payload validation

## Model Routing Guidance

Keep model choice data-driven:
- Route by historical quality per scan type and repo domain.
- If Gemini is preferred for code reasoning in your workload, route specific scan classes to Gemini via Eliza model plugin, not all traffic.
- Keep fallback chain configured for degraded provider states.

Gudtek note:
- current analyzer defaults to Gemini; use RLM to decide when fallback or alternate routing is warranted by measured outcomes.

## Guardrails

- Never train on unverified findings only.
- Keep lessons scoped by project/repo unless cross-project lift is proven.
- De-duplicate near-identical lessons before storage.
- Track prompt version and strategy version in metadata.
- Keep an emergency rollback switch for new strategy docs.

## Deliverables Checklist

- New/updated schema for scan events + outcomes.
- Evaluator for scan-model lessons.
- Provider injecting scan lessons.
- Reflection worker for strategy synthesis.
- Metrics dashboard or endpoint for trend comparison.
- Backtest report showing before vs after quality.

## Agent Execution Mode

When invoked by an agent, execute in this order:
1. Read phase docs and choose target repo (`itachi-memory` vs `gudtek`).
2. Implement Phase 0 fully (schema + routes + event IDs + metrics baseline).
3. Implement Phase 1 (reward mapping + evaluator + lesson storage).
4. Add tests before any strategy auto-activation.
5. Produce a delta report with metric impact and rollback path.
