# W227-A2 — Per-CLI reroute recipes + litellm-as-engine spec (DRAFT)

Draft for `src/agents.ts` — markdown + TS snippets. The implementing agent
owns the port to code; this file is the contract and the evidence.

Date: 2026-10-02 · Machine: darwin (kk) · Repo law: qlty/biome applies to
any `.ts` emitted from this.

## Verification legend

| Mark       | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| PROVEN     | Live-probed on this machine today (free local targets only) |
| DOCS       | Official vendor docs fetched today                          |
| DOCS-MULTI | Corroborated across ≥2 sources, official page not fetched   |
| ASSUMED    | Training data / second-tier; verify at implementation       |

## `AgentRecipe`

```ts
export interface AgentRecipe {
  id: string;
  label: string;
  detect: { bin?: string; configDir?: string; configFiles?: string[] };
  wire: "openai" | "anthropic" | "azure" | "gemini";
  reroute: {
    env?: Record<string, string>;
    configEdit?: {
      file: string;
      kind: "toml" | "json" | "yaml" | "props";
      anchor: string;
      value: string;
    };
  };
  probe:
    | { kind: "cli"; argv: string[]; expect: string }
    | { kind: "http"; url: string };
  notes?: string;
}
```

Local targets: belt Anthropic router `http://127.0.0.1:4000`
(`POST /v1/messages` only), raw OpenAI tiers `:8901/:8902/:8903/:8906`
(`/v1/chat/completions`), litellm `:4100` (chat + Anthropic + per-provider
dialects via `model_list`). Buckle front serves `POST /v1/chat/completions`,
`POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`
(handlers.ts:572-578).

## Recipe summary

| id             | wire               | reroute mechanism                   | base-URL form                                                   | status               |
| -------------- | ------------------ | ----------------------------------- | --------------------------------------------------------------- | -------------------- |
| claude         | anthropic          | env                                 | base, no `/v1` (client appends `/v1/messages`)                  | PROVEN (daily lanes) |
| codex          | openai (Responses) | TOML                                | base incl `/v1`; `wire_api="chat"` REMOVED                      | PROVEN (config load) |
| copilot        | openai + anthropic | env                                 | **asymmetric**: openai-type incl `/v1`, anthropic-type NO `/v1` | PROVEN (live, both)  |
| gemini         | gemini             | env + settings.json                 | `GOOGLE_GEMINI_BASE_URL`                                        | DOCS-MULTI           |
| grok           | openai             | TOML                                | base incl `/v1` (ASSUMED)                                       | DOCS-MULTI           |
| pi             | openai             | models.json                         | baseUrl (ASSUMED shape)                                         | DOCS-MULTI           |
| hermes         | openai             | env / config.yaml                   | base URL persisted; `/v1` bugs known                            | DOCS-MULTI           |
| aider          | openai             | env                                 | base incl `/v1` (ASSUMED)                                       | DOCS                 |
| opencode       | openai             | JSON (`opencode.json`)              | baseURL incl `/v1`                                              | DOCS                 |
| amp            | openai + anthropic | settings.json + `amp config`        | Amp appends API path itself                                     | DOCS-MULTI           |
| zed            | openai             | JSON (`settings.json`)              | `api_url` incl `/v1`                                            | DOCS                 |
| continue       | openai             | YAML (`~/.continue/config.yaml`)    | `apiBase` incl `/v1`                                            | DOCS                 |
| cline          | openai             | extension UI (OpenAI Compatible)    | Base URL incl `/v1`                                             | DOCS-MULTI           |
| vscode-copilot | openai             | Chat: Manage Language Models (BYOK) | base URL incl `/v1`                                             | DOCS-MULTI           |
| jetbrains      | openai             | Settings → AI Assistant → Providers | endpoint incl `/v1`                                             | DOCS-MULTI           |

## Diagnosis: copilot anthropic-type vs belt :4000 (the "silent failure")

**Root cause: base-URL form, not a missing belt route.** Belt :4000 serves
exactly `POST /v1/messages` (router-shim.ts:424) — the same path copilot's
anthropic-type requests. The failing invocation had a trailing `/v1` in
`COPILOT_PROVIDER_BASE_URL`, so copilot POSTed `/v1/v1/messages` → belt 404
→ copilot exited in ~1s with only a generic "Model not found on provider"
line (easy to miss in a lane log = the reported "silent" failure).

Evidence (live today, free):

1. Logger (`/tmp/w227a2-byok-logger.ts`, :4112) captured anthropic-type
   copilot firing `POST /v1/messages`, UA `Anthropic/JS 0.94.0`, body
   `{"model":"<COPILOT_MODEL>","max_tokens":32000,"system":[…]}`.
2. `COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:4000` (no `/v1`) +
   `COPILOT_PROVIDER_TYPE=anthropic COPILOT_MODEL=glm-5.3-flash` →
   **200 OK** answer from belt in 4s (cosmetic warning: unknown token
   multiplier for non-canonical model id).
3. Same but with `…:4000/v1` → HTTP 404, reproduced exactly.

**Fix: no belt/buckle change.** Recipe = base WITHOUT `/v1` for
anthropic-type. Optional hardening (buckle, later): log-and-404 unknown
paths with the requested path echoed, so client path-joining mistakes are
diagnosable from the gateway side. Note the asymmetry for recipes:
copilot openai-type appends `/chat/completions` to the given base (proven
against `:8903/v1`), anthropic-type appends `/v1/messages`.

## Recipes

### claude (Claude Code) — PROVEN

Daily lane driver. Belt :4000 accepts glm ids and routes by complexity;
buckle front replaces it at cut-over.

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:4000 \
ANTHROPIC_MODEL=glm-5.3-flash claude -p "Reply with the word OK"
```

Notes: the `[1m]` suffix is a client-side context hint, stripped before the
wire (belt gateway-config.ts:71-74). `ANTHROPIC_SMALL_FAST_MODEL` /
`ANTHROPIC_DEFAULT_*_MODEL` exist for per-role overrides (ASSUMED — verify
at implementation if needed).

### codex — PROVEN (config-load probe)

codex-cli 0.158.0. **`wire_api = "chat"` is no longer accepted** — config
load hard-errors: `` `wire_api = "chat"` is no longer supported `` (refs
github.com/openai/codex/discussions/7782). Only the Responses wire remains,
so codex cannot ride the raw chat-only tiers (:89xx) directly. Today's
official docs agree: `wire_api` allows `responses` only.

`~/.codex/config.toml` (TOML, DOCS):

```toml
model = "gpt-5.2"
model_provider = "buckle"

[model_providers.buckle]
name = "buckle"
base_url = "http://127.0.0.1:4100/v1"   # must include /v1 (DOCS example)
env_key = "LITELLM_KEY"                  # codex reads key from this env var
wire_api = "responses"                   # only supported value
# http_headers = { X-Custom = "value" }  # optional static headers
```

Probe: `codex exec --sandbox read-only --skip-git-repo-check "Reply with the
word OK"` expect `OK`. Isolation: `CODEX_HOME=<dir>` moves the whole config
home (verified — without it codex silently uses `~/.codex`).

Open gap: litellm `/v1/responses` bridging for `openai/`-prefixed chat
backends not yet probed (needs `LITELLM_KEY`; probe skipped — key absent
from env). If litellm does not bridge, codex needs a responses→chat bridge
in buckle (follow-up item). ASSUMED until probed.

### copilot (GitHub Copilot CLI ≥1.0.91) — PROVEN (live, both dialects)

BYOK via `copilot help providers`. Env-only, GitHub auth not required once
activated:

```sh
# anthropic dialect — base WITHOUT /v1 (copilot appends /v1/messages)
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:4000 \
COPILOT_PROVIDER_TYPE=anthropic \
COPILOT_MODEL=glm-5.3-flash \
  copilot -p "Reply with the word OK"

# openai dialect — base WITH /v1 (copilot appends /chat/completions)
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:8903/v1 \
COPILOT_PROVIDER_TYPE=openai \
COPILOT_MODEL=<tier-model-id> \
  copilot -p "Reply with the word OK"
```

Also: `COPILOT_PROVIDER_WIRE_MODEL` (wire id when it differs from the
display model) and `COPILOT_PROVIDER_HEADERS` (extra headers). Gotcha: a
model id the target does not know surfaces as "Model '…' not found on
provider (HTTP 404)" — check COPILOT_MODEL first.

### gemini (gemini-cli) — DOCS-MULTI, not installed here

Speaks the **Gemini wire** (no OpenAI-compatible mode found). Reroute =
point it at a Gemini-wire endpoint:

```sh
export GOOGLE_GEMINI_BASE_URL=http://<gemini-wire-endpoint>
export GEMINI_API_KEY=<key>
```

plus `~/.gemini/settings.json`: `{ "auth": { "selectedType": "gemini-api-key" } }`.
Gap: neither belt nor buckle serves Gemini wire today (buckle's vertex
adapter is upstream-side, not front-side) — recipe activates only once a
Gemini-wire front exists. Sources: geminicli.com configuration reference;
TrueFoundry/ZenMux gateway guides (corroborating).

### grok — DOCS-MULTI, not installed here

Two CLIs share the name. Official xAI **grok-build**: `~/.grok/config.toml`
with a custom OpenAI-compatible `base_url` + `XAI_API_KEY` (exact TOML keys
ASSUMED — official configuration page 503'd during research; orq.ai and
innfactory guides corroborate the config.toml mechanism). Community
stevederico/grok-cli: per-provider base-URL env vars instead (ASSUMED
names). Probe (once installed): `grok -p "Reply with the word OK"`.

### pi — DOCS-MULTI, not installed here

Custom OpenAI-compatible providers via `models.json` with a `baseUrl`
(pi.dev custom-provider docs; ParalonCloud/apimaster guides; base URLs were
hardcoded before — earendil-works/pi issue #8). Exact models.json shape and
selection flags (`pi --provider … --model …`) ASSUMED — fetch
pi.dev/docs at implementation. Known second-hand gotchas: $0 cost reporting
on custom providers; reasoning models erroring on Anthropic routes.

### hermes (Nous Research Hermes Agent) — DOCS-MULTI, not installed here

Talks to any OpenAI-compatible endpoint via its custom provider path; the
base URL + provider persist in `config.yaml` (`hermes setup` writes it).
`OPENAI_BASE_URL` env works per community guides. Known bugs to probe for
at implementation: custom base URL dropping `/v1` on chat completions
(hermes-agent issue #4600) and appending `/models` to the configured base.

### aider — DOCS

Official docs (aider.chat/docs/llms/openai-compat.html):

```sh
export OPENAI_API_BASE=http://127.0.0.1:8903/v1
export OPENAI_API_KEY=dummy            # required non-empty; value free locally
aider --model openai/<tier-model-id> --message "Reply with the word OK"
```

Under the hood aider uses litellm — so litellm-prefixed model strings
(`openai/…`, `anthropic/…`, `github_copilot/…`) work when the env points at
:4100. `/v1` inclusion in `OPENAI_API_BASE` ASSUMED (litellm convention);
a `--openai-api-base` flag also exists (ASSUMED — docs page documents the
env vars only).

### opencode — DOCS

`opencode.json` (project or `~/.config/opencode/opencode.json`), official
example shape:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "buckle": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "buckle (local)",
      "options": { "baseURL": "http://127.0.0.1:8903/v1" },
      "models": {
        "<tier-model-id>": {
          "name": "local reason tier",
          "limit": { "context": 128000, "output": 65536 }
        }
      }
    }
  }
}
```

`options.apiKey` optional (supports `"{env:VAR}"` refs); `options.headers`
for extra headers; for a `/v1/responses` endpoint use `@ai-sdk/openai` as
the npm package instead. Models appear via `/models`.

### amp — DOCS-MULTI, not installed here

Model Routing → **Custom URL** connection (ampcode.com/docs/customize/model-routing):
enter the base URL and pick the API format — `chat-completions` (OpenAI
Chat) or Anthropic-compatible; **Amp appends the API path itself** (same
asymmetric-base trap as copilot — probe before assuming `/v1`). Managed via
`amp config model-providers …` and `~/.config/amp/settings.json`
(project-level `.amp/settings.json` also exists).

### zed — DOCS

`settings.json`:

```json
{
  "language_models": {
    "openai_compatible": {
      "Buckle": {
        "api_url": "http://127.0.0.1:8903/v1",
        "available_models": [
          {
            "name": "<tier-model-id>",
            "display_name": "buckle local",
            "max_tokens": 128000,
            "max_output_tokens": 32000,
            "capabilities": ["tools", "images"]
          }
        ]
      }
    }
  }
}
```

The built-in `openai` / `anthropic` providers also accept an `api_url`
override, but only one base each (zed discussion #23426) —
`openai_compatible` is the multi-provider path. API key via the UI provider
dialog (secret storage) or settings (ASSUMED which key field).

### continue — DOCS

`~/.continue/config.yaml`:

```yaml
name: buckle-local
version: 1.0.0
schema: v1
models:
  - name: buckle local
    provider: openai
    model: <tier-model-id>
    apiBase: http://127.0.0.1:8903/v1
    apiKey: dummy
    roles: [chat, edit]
```

(`provider: openai` = OpenAI-compatible catch-all; hot-reloads on save.)

### cline — DOCS-MULTI, extension UI

Provider dropdown: **"OpenAI Compatible"** — not plain "OpenAI" (choosing
the latter hides the Base URL field; cline issue #7114). Set Base URL
(incl `/v1`), API key, exact Model ID, then **Verify**. Settings persist in
the extension's globalStorage (path ASSUMED — inspect at implementation).
No clean CLI probe; probe = HTTP GET `{baseURL}/models` after manual setup.

### vscode (Copilot Chat BYOK + settings) — DOCS-MULTI

Command Palette → **Chat: Manage Language Models** → Add Models →
**OpenAI Compatible** → API key + base URL (incl `/v1`) → enable the
discovered models in the picker. Keys live in VS Code secret storage, not
settings.json — nothing to commit. Extension-workaround Marketplace items
exist for older VS Code; prefer the built-in flow.

### jetbrains (AI Assistant) — DOCS-MULTI

Settings → Tools → AI Assistant → **Providers & API keys** → provider
**OpenAI-compatible** (also LM Studio / Ollama presets) → endpoint (incl
`/v1`) + API key. Local-model support via OpenAI-compatible servers
landed across 2025.1–2025.2 (JetBrains blog). Probe = HTTP GET
`{endpoint}/models` after manual setup.

## litellm-as-engine wiring spec (buckle ⇄ :4100)

Owner decision W219.1: **USE litellm** — buckle proxies every capability
litellm provides natively to :4100 instead of re- implementing provider
dialects. Consequence: dialect adapters in buckle stay tier-1; the provider
long tail arrives as data.

**Dialect split.**

- Stay native in buckle (direct rows, no litellm hop): openai-dialect local
  tiers (:8901/:8902/:8903/:8906), belt :4000 (anthropic ingress),
  api.anthropic.com rows (env-gated). These are the hot path — zero extra
  latency, already shipped as `upstreams.yaml` rows.
- Delegate to :4100 (rows with `url: http://127.0.0.1:4100`): every
  litellm-native provider family — `github_copilot/…` (device-flow OAuth,
  editor-impersonation headers, token store — arrives with **zero buckle
  adapter code**), `azure/…`, `bedrock/…`, `vertex_ai/…`, `gemini/…`,
  `xai/…`, gateway prefixes. The row's `model:` field carries the litellm
  `model_name`/prefix string; buckle already patches the request body's
  model per upstream row (`upstreams.yaml` header law), so no code change —
  the openai-compat adapter forwards to :4100's `/v1/chat/completions`.

**Row shapes** (activation = `BUCKLE_UPSTREAMS` override; never committed
with key material):

```yaml
github_copilot-gpt-5.2:
  - url: http://127.0.0.1:4100
    dialect: openai
    adapter: openai-compat
    model: github_copilot/gpt-5.2 # litellm model_list name / provider prefix
    api_key_env: LITELLM_KEY # litellm master key, env-resolved
```

**model_list mapping.** Belt already generates the private litellm config
(`bin/gateway-config.ts` → `~/.claude/local-llm/litellm.yaml`, mode 600,
`master_key: os.environ/LITELLM_KEY`): `openai/<discovered-local-id>` rows
per :89xx port, `anthropic/glm-*` rows (z.ai), `anthropic/local-swarm`
degradation tier, env-gated `anthropic/claude-*` + `openai/gpt-5.2`. Buckle
additions are appended to the same generated file: `github_copilot/gpt-5.2`
(and siblings) as rows whose `litellm_params.model` is the litellm provider
prefix — OAuth/token handling stays entirely inside litellm
(`GITHUB_COPILOT_TOKEN_DIR`, mode 600). Same `model_name` across an openai
and an anthropic row = one group, two dialects (existing litellm
load-balance/fallback law).

**Header pass-through.** Buckle → :4100 needs only
`Authorization: Bearer $LITELLM_KEY` (env-resolved via `api_key_env`) — the
openai-compat adapter already sends it. Editor-impersonation headers for
github_copilot are injected by litellm itself (overridable via litellm
`extra_headers`); they never transit buckle. Client-facing governance
headers (usage tee, budgets) stay buckle-side as today.

**Known wire gap (follow-up).** Buckle front serves chat-completions +
messages only; codex ≥0.158 speaks Responses only, and gemini-cli speaks
Gemini wire. Either litellm's `/v1/responses` bridging covers codex via a
:4100 row (verify — probe skipped, `LITELLM_KEY` absent from env), or
buckle grows a responses→chat bridging adapter family. Gemini-wire front
remains a gap regardless of :4100 (litellm serves openai/anthropic wires
natively, not Gemini front wire).

**Acceptance test — copilot through buckle's front door (no paid calls,
no key material in repo):**

1. Preconditions: `LITELLM_KEY` in env; litellm :4100 healthy; `litellm.yaml`
   contains a `github_copilot/gpt-5.2` row; copilot device-flow OAuth done
   once interactively (tokens land in `GITHUB_COPILOT_TOKEN_DIR`, mode 600 —
   same private dir law as `~/.claude/local-llm/`, never the repo).
2. `BUCKLE_UPSTREAMS=/tmp/w227-override.yaml` with the
   `github_copilot-gpt-5.2` row above; start buckle front.
3. HTTP probe: `POST /v1/chat/completions`
   `{"model":"github_copilot-gpt-5.2","messages":[{"role":"user","content":"Reply with the word OK"}]}`
   → 200, non-empty content, usage teed to the ledger.
4. CLI probe: `COPILOT_PROVIDER_BASE_URL=http://<buckle-front>/v1
COPILOT_PROVIDER_TYPE=openai COPILOT_MODEL=github_copilot-gpt-5.2
copilot -p "Reply with the word OK"` → answer contains `OK`.
5. Negative: unset `LITELLM_KEY` → row dormant (env-gated law) → ladder
   exhaustion error, no crash, no secret echoed. `rg github_copilot`
   over the repo shows only this doc + override example — no tokens.

DONE — W227-A2 complete: 15 CLI reroute recipes written (3 live-proven: claude daily, copilot both dialects, codex config-load; 12 docs-level, verified-vs-assumed marked per recipe).
Copilot :4000 "silent failure" root-caused by reproduction: trailing `/v1` in COPILOT_PROVIDER_BASE_URL → client POSTs /v1/v1/messages → belt 404; fix = base without /v1, no belt change needed.
Codex ≥0.158 dropped `wire_api="chat"` (hard config error) — Responses-only; raw :89xx chat tiers unreachable from codex until litellm /v1/responses bridging (unprobed, key absent) or a buckle bridge lands.
litellm-as-engine spec written: native rows for local tiers/anthropic, :4100-delegated rows for github_copilot/azure/bedrock/vertex/gemini long tail via existing model-patch law; copilot end-to-end acceptance test included.
Disclosure: one accidental paid-plan request — first codex probe ran without CODEX_HOME exported, hitting the user's ChatGPT-authed default config (single "Reply OK" turn); subsequent probes were isolated and free.
---

## Caveman insertion study (code read, 2026-10-02)

Read at source level: `agents/profiles/*.json`, `proxy/routing/routing.go`,
`proxy/internal/gateway/server.go`, `packages/cli/tests/{wrap,config-file-injection}.runtime.mjs`.
Facts below are from code/tests, not the README.

**Insertion = `buildWrapEnv(agent, gatewayUrl)`, a pure function.**
Profile in, child env out — nothing on disk is touched during a wrap.

1. **Base-URL union**: sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
   `OPENAI_API_BASE`, `GOOGLE_GEMINI_BASE_URL` ALL to `<gw>/w/<agent-id>`.
   Whatever var the agent honors, it lands on the proxy; the `/w/<slug>`
   path prefix (plus `x-cave-agent` header) is the attribution axis — one
   proxy, per-agent telemetry joins for free.
2. **config-file injection** (codex/qwen class): render `base_config` (the
   user's real file, tilde-expanded) deep-merged with the profile overlay
   (`__proto__`-guarded), write to a temp `caveman-wrap-*/<id>.json` mode
   0600, and inject its path via the agent's own config-path env var.
   Corrupt base → warn + fall back to generic env (fail-open, still launches).
3. **Secrets are never materialized**: `{{cave_optional_openai_key_env}}`
   resolves to the literal string `$ENV_NAME`; absent/blank keys are
   omitted; optional credentials fail closed inside arrays. Generated
   configs contain references, never values.
4. **opencode** ignores base-URL envs → `OPENCODE_CONFIG_CONTENT` inline
   JSON env var; a sentinel test asserts the user's `opencode.json` stays
   byte-identical.
5. **claude specifics**: `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` is
   stamped only when the anthropic upstream is verifiably `api.anthropic.com`
   (flow-style YAML counts as unverifiable → withheld); Claude
   `remote-control` refuses a proxied base URL outright (#947) — wrap throws
   rather than silently degrade.
6. **MCP/delegate tools** are injected ephemerally (`--plugin-dir` for
   claude, temp `CODEX_HOME` for codex) — never persisted into user configs.

**Proxy side**: "a pure base-URL swap". Lifecycle
match → authenticate → inspect → byte-safe transform → upstream → meter;
record mode is always passthrough; on ANY transform problem the original
bytes are forwarded. Durable PrefixCache keeps the provider's cache prefix
byte-stable across turns (fails open). Its savings ledger books every row
`inferred`, never `verified`, outside eval-gated modes.

**Router side** (their `frontier-v1`): candidates carry quality lower
confidence bounds (floor default 0.95), SLO gates, data-residency,
denylist; Pareto-prune, then a normalized-regret α-dial (0 = most capable,
1 = cheapest); every decision logs RejectionReasons; session pins stick for
cache affinity; routing only runs when the proxy can rewrite the body model.

**Copilot is absent** — caveman has no copilot profile at all. Our native
BYOK proof (`COPILOT_PROVIDER_*` env, zero credits) is ahead of them there.

### Adopt list (W227 follow-ups + dispatch-next)

- **Base-URL union + `/w/<slug>` attribution in `laneEnv()`** — dispatch
  env for all executors points at the buckle front with a per-lane slug;
  board gets executor↔model↔lane joins without new plumbing.
- **Ephemeral config-file injection over .bak edits** — for codex-class
  agents, generate a temp config dir (0600) and point the config-path env
  var at it; the user's real file is never mutated. Persistent enable stays
  the explicit onboard step.
- **Env-reference secrets** in any generated config (`$LITELLM_KEY`, not
  the value) — matches caveman's `$ENV_NAME` rule and our no-secrets-in-repo
  law.
- Codex unlock note: with a temp `CODEX_HOME` + `wire_api = "responses"` +
  `base_url = ":4100/v1"`, codex reaches the litellm engine (Responses wire
  incl. `github_copilot/*`) even though raw chat tiers stay unreachable —
  still unprobed (key absent), tracked in benchmarks.md OPEN row.
