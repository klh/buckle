# buckle cut-over runbook (:4101 shadow → :4100 live)

**OWNER GATE: cut-over needs owner sign-off.** This runbook makes that
decision trivial; it never makes it. No lane flips ports, swaps launchd
labels, or restarts the live :4100 gateway — restarts happen between
fan-outs, on the coordinator's call.

## State of the machine

| surface   | today (2026-10-01)                                                                                                     | after cut-over                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| :4100     | belt gateway (fallback), chat route 500ing; anthropic route serving                                                    | buckle, the live gateway                |
| :4101     | buckle shadow (started per-run; guard: refuses 4100 by design)                                                         | keeps serving as shadow, then retires   |
| label     | `com.belt.gateway` (`bun <repo>/belt/bin/gateway.ts`)                                                                  | `com.klh.buckle.gateway` (created once) |
| agent env | settings `ANTHROPIC_BASE_URL=http://127.0.0.1:4100` (unchanged by cut-over — only the process behind the port changes) | same value, now answered by buckle      |

Cut-over swaps the PROCESS behind :4100, not client config: the agent
settings keep pointing at :4100, so rollback is a reverse label swap.

## Acceptance checklist (master-plan W144 row)

| #   | check                           | gate                                      | evidence (2026-10-01)                                                                                                                                                                                                                                          | state |
| --- | ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | W89.1 e2e (agent client)        | real client completes through :4101       | PASS — `claude -p` via ANTHROPIC_BASE_URL=:4101, `result: "w144-e2e-ok"`, end_turn, api 1963ms, glm-5.3-flash 9403/35 tok; transcript sha256 `8ff7dde1652c763ae04c1792247ffa670db61d173ca67e9659c93b0e15eac7c4`; route_audit rid `rmupktzasi6g3kx` 200 @1943ms | PASS  |
| 2   | latency gate p50<5ms / p95<15ms | all four gate scenarios                   | W143 n=600: stream-short 0.127/0.439, non-stream-short 0.060/0.236, concurrent-50 0.357/0.644, failover-pre-byte 0.141/0.412 — ~20x headroom; W144 day-1 shadow sample: 0.151/0.472, 0.062/0.129, 0.314/0.659, 0.143/0.412 — all pass                          | PASS  |
| 3   | byte identity                   | 100% on proxied scenarios                 | W143 + W144 day-1: 100% on every proxied scenario (deterministic mock upstreams). Real-upstream request-to-request byte compare is NOT measurable on a sampling upstream — noted honestly, not faked; pass-through doctrine + bench identity is the guarantee  | PASS  |
| 4   | test suite                      | green on the shared worktree              | 156 pass / 0 fail (W143 record) + W144's 9 shadow-week tests                                                                                                                                                                                                   | PASS  |
| 5   | shadow week                     | 7 consecutive daily runs, zero hard flags | day 1 recorded (bin/shadow-week.ts), litellm row honestly `available=false`                                                                                                                                                                                    | 1/7   |
| 6   | anthropic ingress data          | committed pool serves Claude Code ids     | OPEN — committed upstreams.yaml is openai-only; /v1/messages 503s `no_route` without a runtime override (the e2e used one). Fix is data, per the W89.1 ingress spec                                                                                            | OPEN  |
| 7   | LiteLLM baseline row            | record-only, honest                       | OPEN — :4100 openai route 500ing (bench: 50/50 unreachable, `available=false`); the anthropic route through :4100 served the e2e transit                                                                                                                       | OPEN  |

Sign-off requires rows 1–5 green and rows 6–7 resolved or explicitly
accepted by the owner.

## Shadow week ops (row 5)

Daily, launchd-friendly (StartInterval 86400, bun one-liner — no shell
scripts):

    bun <repo>/buckle/bin/shadow-week.ts

Env-configurable: `BUCKLE_SHADOW_DIR` (default `<repo>/buckle/shadow`,
add to .gitignore — runtime data), `BUCKLE_LITELLM_URL`,
`BUCKLE_SHADOW_URL`, `BUCKLE_SHADOW_LOG`. Behavior: runs the W143 bench
(n=600) with the LiteLLM baseline recorded honestly, diffs against the
prior day (scenario-keyed; hard = gate-fail/gate-budget/byte-identity,
soft = >2x-prior tolerance drift, availability transitions,
missing-scenario), bounds the log at 7 days. Exit 1 on a hard flag.
`--skip-bench` for a probe-only day. A plist template (placeholders only,
no machine paths) lives in the runbook's companion, not committed:

    <dict> StartInterval 86400, ProgramArguments [bun, <repo>/buckle/bin/shadow-week.ts],
    EnvironmentVariables {BUCKLE_SHADOW_DIR: <state-dir>/shadow-week} </dict>

## Cut-over steps (owner, after sign-off)

1.  **Freeze window**: coordinate between fan-outs; nothing else transits
    :4100 during the swap (coordinator's call).
2.  **Lift the 4100 guard deliberately**: `src/server.ts` `resolvePort`
    refuses 4100 from any source until the owner flips it — that flip is
    a reviewed one-line change, part of the sign-off commit, never a lane
    action.
3.  **Create the live label** `com.klh.buckle.gateway`: bun +
    `<repo>/buckle/src/server.ts`, RunAtLoad, env `BUCKLE_DB` to the
    state dir, `BUCKLE_UPSTREAMS` to the operator override (row 6), auth
    per the governance posture decision.
4.  **Shadow → live swap**: `launchctl bootout gui/$UID/com.belt.gateway`;
    `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.klh.buckle.gateway`;
    verify `GET :4100/status` says service=buckle, then a `claude -p`
    smoke test through :4100.
5.  **Belt stays installed as fallback** (label loaded but not running,
    or loaded on demand): its chat route is currently 500ing anyway —
    the fallback's state is recorded daily by shadow-week, never faked.

## Rollback (reverse swap)

    launchctl bootout gui/$UID/com.klh.buckle.gateway
    launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.belt.gateway
    # verify GET :4100/health/liveliness, then a claude -p smoke

Client config never changed, so the reverse swap is complete rollback.
Post-incident: file the swap reason as a decision record; shadow-week
keeps running either way.

## Open items (today, 2026-10-01)

- **Row 6 (blocking)**: the committed pool carries no anthropic-dialect
  deployment, so Claude Code ids cannot route (503 no_route) without a
  runtime BUCKLE_UPSTREAMS override. Owner decision: add the upstream
  data vs wire the cross-dialect adapter path (W139's transform covers
  tools; a full anthropic→openai translator is unbuilt).
- **Row 7**: LiteLLM baseline row unavailable (:4100 openai route 500ing
  all day); shadow-week records `available=false` until it returns.
- Shadow week 1/7 days.
