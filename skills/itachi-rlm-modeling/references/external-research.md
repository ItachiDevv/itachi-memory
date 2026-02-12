# External Research for RLM Modeling

Use these sources when designing the learning loop and evaluation method.

## ElizaOS Primary Sources

- Plugin architecture (actions/providers/evaluators/services):
  - https://docs.eliza.how/plugins/architecture
- Services and task workers:
  - https://docs.eliza.how/plugins/services
- Plugin patterns and interfaces:
  - https://github.com/elizaOS/eliza

## Gemini in Eliza (Model Routing Option)

- Eliza Google GenAI plugin:
  - https://www.npmjs.com/package/@elizaos/plugin-google-genai

Use this to route selected scan tasks to Gemini while keeping model abstraction in Eliza.

## Learning-Loop Papers (Primary)

- Reflexion: verbal feedback to improve future decisions
  - https://arxiv.org/abs/2303.11366
- Self-Refine: iterative self-feedback and revision
  - https://arxiv.org/abs/2303.17651
- Generative Agents: memory retrieval based on relevance + recency + importance
  - https://arxiv.org/abs/2304.03442
- SWE-bench: realistic software-task benchmark framing
  - https://arxiv.org/abs/2310.06770

## How to Apply These Sources Here

- Reflexion and Self-Refine justify storing explicit lessons and strategy revisions instead of one-shot prompts.
- Generative Agents supports weighted lesson retrieval (not just cosine similarity).
- SWE-bench reinforces the need for measurable outcomes and held-out evaluation windows.
- Eliza plugin docs define where to implement this as evaluator/provider/worker/services.
