# benchmarks.md — buckle gateway (curated)

THE canonical benchmark table for buckle (owner law, 2026-10-02). One
curated row per wire/adapter/backend, few params, medians decide. The
questions we ask live in [bench-questions.md](bench-questions.md).

**Do not store bench data in other .md files** — update this table instead.
Laws: run on **AC power only** (never battery); medians over N≥12 unless
noted; speed rows are solid, quality rows need ≥130 paired questions
(33 → ±15pts, 130 → ±7, 530 → ±4) — anything smaller is a smoke test; score
per class, never blended; one lever at a time.

## Wire/adapter probes (verified 2026-10-02)

| Probe                                 | Path                                   | Result                                                                   |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| copilot BYOK openai-wire → local tier | `COPILOT_PROVIDER_*` → :8903 `/v1`     | PASS — answered `PROOF-BYOK-LOCAL`, zero AI credits, no GitHub auth      |
| claude CLI → belt router              | `ANTHROPIC_BASE_URL=:4000` + model pin | PASS — daily lanes run this                                              |
| copilot BYOK anthropic-wire → :4000   | `COPILOT_PROVIDER_TYPE=anthropic`      | FAIL — silent 1s abort; diagnosis pending (W223)                         |
| codex → :4100 responses wire          | CODEX_HOME `model_providers`           | OPEN — codex ≥0.158 is Responses-only; chat tiers unreachable from codex |

## Engine (W219.1 litellm-as-engine) — pending acceptance

| Dialect                          | Acceptance probe                     | Status |
| -------------------------------- | ------------------------------------ | ------ |
| github_copilot/gpt-5.2 via :4100 | e2e chat answer through buckle front | OPEN   |
| azure/bedrock/vertex via :4100   | e2e chat answer through buckle front | OPEN   |

## Rejection log

| Date       | Thing                        | Verdict                                                                                                                                    |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-02 | kev-4B as buckle fit backend | 4/12 agreement, 3.6× latency, 1.6× tokens vs :8902 chat-JSON (W225)                                                                        |
| 2026-10-02 | Jev as first-hit classifier  | 62.6% single-question phishing (beri.net); only decomposition + fitted weights reached 95%; see bench-questions.md decision-model protocol |
