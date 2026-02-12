# RLM Phase 0 (Detailed): Instrumentation + Ground Truth Pipeline

## Objective

Build complete observability for scan quality so learning is based on evidence, not guesses.

Phase 0 does **not** change model behavior yet. It only ensures every analysis and outcome is recorded with stable identifiers.

---

## 1. Scope

### In scope

- schema additions for scan analysis events and outcomes
- new ingestion endpoints
- deterministic finding keys
- metadata versioning (`prompt_version`, `strategy_version`)
- baseline metric endpoint (read-only)

### Out of scope

- lesson extraction
- provider injection
- model routing adaptation
- auto policy rollouts

---

## 2. Deliverables

1. New migration under `supabase/migrations/` for:
   - `scan_analysis_events`
   - `scan_finding_outcomes`
2. Route contracts:
   - `POST /api/scan/analyze`
   - `POST /api/scan/outcome`
   - `GET /api/scan/metrics` (baseline only)
3. Deterministic finding-key utility in code-intel service layer.
4. Operational runbook with example payloads and failure modes.

---

## 3. Data Contracts

## 3.1 `POST /api/scan/analyze`

### Request (example)

```json
{
  "project": "gudtek",
  "target_id": "repo:dexteraisol/dexter-core",
  "scanner": "gudtek_phase1",
  "model_provider": "google",
  "model_name": "gemini-3-pro-preview",
  "prompt_version": "phase1-v3.2",
  "strategy_version": "none",
  "input_features": {
    "files_count": 10,
    "languages": ["TypeScript", "Rust"],
    "timeline_suspicious": false
  },
  "findings": [
    {
      "category": "security_risk",
      "summary": "Potential unsafe authority controls in token mint logic",
      "confidence": 0.82,
      "severity": "high"
    }
  ],
  "score": 68
}
```

### Response (example)

```json
{
  "success": true,
  "analysis_event_id": "2d6943f0-4d0d-43f7-9306-7c8d653458af",
  "finding_keys": [
    "sha256:5d9be52cf9f2..."
  ]
}
```

---

## 3.2 Deterministic finding key

Key must be reproducible for dedupe and outcome matching:

```
finding_key = SHA256(
  normalize(project) + "|" +
  normalize(target_id) + "|" +
  normalize(category) + "|" +
  normalize(summary) + "|" +
  normalize(optional_file_path)
)
```

Normalization rules:
- lowercase
- trim spaces
- collapse repeated whitespace
- strip markdown symbols

---

## 3.3 `POST /api/scan/outcome`

### Request (example)

```json
{
  "analysis_event_id": "2d6943f0-4d0d-43f7-9306-7c8d653458af",
  "finding_key": "sha256:5d9be52cf9f2...",
  "label": "rejected_fp",
  "source": "human_reviewer",
  "notes": "This pattern is expected in this framework",
  "evidence": {
    "review_url": "https://github.com/org/repo/pull/123#discussion_r..."
  }
}
```

### Response

```json
{
  "success": true,
  "outcome_id": "3adca669-f67f-4f4a-a915-ac04fca58a81"
}
```

---

## 3.4 `GET /api/scan/metrics`

Purpose in Phase 0:
- baseline visibility only

Minimum payload:
- total analyses
- total labeled findings
- label distribution
- per-model labeled count

---

## 4. Migration Spec

## 4.1 Table: `scan_analysis_events`

Recommended constraints:
- `id` default uuid pk
- `project` not null
- `target_id` not null
- `scanner` not null
- `model_provider` not null
- `model_name` not null
- `prompt_version` not null
- `strategy_version` nullable (default `none`)
- `findings` jsonb not null
- `created_at` default now

Indexes:
- `(project, created_at desc)`
- `(scanner, created_at desc)`
- `(model_provider, model_name, created_at desc)`

## 4.2 Table: `scan_finding_outcomes`

Recommended constraints:
- `id` default uuid pk
- `analysis_event_id` fk to events
- `finding_key` not null
- `label` check in (`accepted`,`rejected_fp`,`fixed`,`reopened`,`ignored`)
- `source` not null
- `created_at` default now

Indexes:
- `(analysis_event_id, created_at desc)`
- `(finding_key, created_at desc)`
- `(label, created_at desc)`

Idempotency:
- optionally unique on `(analysis_event_id, finding_key, label, source, created_at::date)` or caller-provided idempotency key.

---

## 5. Service-Level Implementation

### 5.1 `ScanAnalysisService` (code-intel)

Responsibilities:
- validate payload
- normalize findings
- generate finding keys
- write event row
- return event ID + keys

### 5.2 Validation rules

- `project` required and max length bounded
- findings array capped (for example max 100)
- each finding requires:
  - `category`
  - `summary` (min length > 8)
  - `confidence` range [0,1]

### 5.3 Failure handling

- malformed payload -> `400`
- missing event key on outcome -> `404` or `422`
- duplicate idempotent write -> `200` with same outcome ID or `409` per policy

---

## 6. Testing Plan

### 6.1 Unit tests

- finding key determinism:
  - same normalized finding => same key
  - whitespace/case variations => same key
- payload validation rejects malformed data

### 6.2 Integration tests

- create analysis event, then attach outcome
- attach outcome to unknown event should fail
- metrics endpoint reflects inserted rows

### 6.3 Load smoke

- batch insert 100 events with 20 findings each
- verify route latency and DB write throughput

---

## 7. Observability

Log fields for every write:
- `project`
- `scanner`
- `model_provider`
- `model_name`
- `analysis_event_id`
- `finding_count`
- `prompt_version`
- `strategy_version`

Add alert thresholds:
- surge in rejected payloads
- zero labeled outcomes over rolling period

---

## 8. Completion Criteria

Phase 0 is complete when:

1. Every analysis request has a durable event row.
2. Every user/system outcome can be attached to a deterministic finding key.
3. Metrics endpoint can produce baseline label distributions.
4. Integration tests confirm end-to-end write and read paths.

---

## 9. Gudtek Mapping Notes

Gudtek already has:
- `analysis_cache`
- append-only `analysis_history`

For fast adoption, Phase 0 can be layered without breaking existing flow:
- keep `analysis_cache` and `analysis_history` for product behavior
- add dedicated scan outcome tables for RLM training signals
- write new rows from:
  - `app/api/github-legitimacy/route.ts`
  - `app/api/developer-code-analysis/route.ts`
  - `app/api/developer-code-analysis-stream/route.ts`
