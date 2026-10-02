# buckle

LLM router plane: dual-dialect pass-through (cross-dialect failover
opt-in: `BUCKLE_CROSS_DIALECT=on`), adapters, routing laws,
governance, knowledge aids. Companion of belt (fleet) + suspenders
(control plane). Design docs live in suspenders `docs/design/buckle/`.

## UI law

NEVER `innerHTML` / `document.write` (blocked by the write-gate).
`document.createElement` only inside web components (lit). UI = Lit
components + design tokens per klh-core-components / klh-lit-dev skills.
