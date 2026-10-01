# buckle

Belt-adjacent LLM router: transport + governance in one Bun/TS process.
Belt keeps the fleet logic (resolution, scoring, complexity tiers, audit of
route decisions); buckle is the LiteLLM-replacement transport layer — two
wire dialects (OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`),
SSE pass-through with a usage-only tee, the W124 ladder walk, retry with
retry-after honoring, cooldown ejection, an hour-bucket usage ledger and the
W125 servicemon standard.

**Status: shadow-port, phase 1 (the thin slice).** Bound to
`127.0.0.1:4101` — belt's live `:4100` is refused by a startup guard until
the owner flips it deliberately (shadow-then-cut migration per the design
doc).

Design sources (read these before changing semantics):

- `docs/design/belt-native-router-2026-10-01.md` in the suspenders repo —
  architecture, thin-slice definition, build order, risk register
- `docs/research/litellm-internals-2026-10-01.md` (W129) — line-precise
  LiteLLM references (usage sniff on the terminal SSE chunk,
  `_calculate_retry_after` semantics, cooldown/allowed_fails)
- belt `bin/routing-policy.yaml` + `bin/router-policy.ts` — the shared
  policy file and the loader pattern this repo ports

## Two-dialect design

Every upstream speaks exactly one of two dialects; the group name is the
wire id (the model string clients send). `upstreams.yaml` (committed,
loopback-only) + a `BUCKLE_UPSTREAMS` override file (never committed —
cloud tiers and keys live there at runtime; `api_key_env` names the env var
holding a bearer token) define the pool. Cloud tiers ship dormant (empty
gpt-5.2 / claude-sonnet-5 groups): a dormant tier in the ladder is a skip,
not a failure.

Ladder (W124, verbatim): `glm-5.3-flash → [local-swarm, gpt-5.2,
claude-sonnet-5]`, `num_retries: 1`, `allowed_fails: 3`, `cooldown_time:
30`, **never flashx** — the walk refuses flashx tiers even if an edit adds
one (owner directive: same upstream family saturates together, and flashx
is too expensive).

## Semantics ported (LiteLLM 1.103.0, MIT core only)

- Usage sniff on the terminal SSE chunk even when the caller never asked
  (`streaming_handler.py`); `stream_options.include_usage` injected toward
  openai-dialect upstreams; anthropic usage rides `message_start` (input
  side incl. cache columns) and cumulative `output_tokens` on
  `message_delta`. Absent usage = honest unknown: the requests column
  increments, token columns contribute nothing, servicemon gets an explicit
  `buckle_usage_unknown_total` — never estimated, never faked zeros.
- Backoff honors upstream `retry-after` (delta-seconds and HTTP-date
  forms), capped exponential `2**attempt` + U[0,1) jitter when absent
  (`utils.py::_calculate_retry_after`).
- Cooldown: `allowed_fails` consecutive failures bench a deployment for
  `cooldown_time` seconds; success resets the counter (cooldown_cache /
  cooldown_handlers semantics at fixed-policy scale).
- Nothing under `litellm_enterprise` was read or transliterated (see
  NOTICE.md).

## Run

```bash
bun install
bun test               # unit + mock-upstream e2e
bun run src/server.ts  # binds 127.0.0.1:4101
bun bin/acceptance.ts  # live e2e vs local swarm (read-only), manual gate
```

Port guard: `BUCKLE_PORT=4100` or an explicit 4100 throws at startup.
Config chains — policy: `BUCKLE_POLICY` → `BELT_POLICY` →
`~/.claude/local-llm/routing-policy.yaml` → committed default; upstreams:
`BUCKLE_UPSTREAMS` merges over the committed `upstreams.yaml`.

## Layout

src/ modules — `policy.ts` (W124 loader port), `upstreams.ts` (pool +
BUCKLE_UPSTREAMS merge), `cooldown.ts` (retry-after math + Cooldowns),
`router.ts` (ladder walk), `wire.ts` (upstream request construction: model
alias patch + include_usage injection), `sse.ts` (usage sniffer), `usage.ts`
(usage extraction both dialects), `handlers.ts` (wire handlers + tee),
`ledger.ts` (bun:sqlite hour-bucket upsert-add ledger, swap-ready for the
W92 openStore binding), `servicemon.ts` (port of suspenders W125, MIT
ours), `server.ts` (Bun.serve seam + 4100 guard). Tests mirror in test/.
