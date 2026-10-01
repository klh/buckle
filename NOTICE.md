# NOTICE

Portions derived from LiteLLM (https://github.com/BerriAI/litellm), MIT License
— routing/retry/usage-accounting algorithms ported to TypeScript.

Ported only from the MIT-licensed litellm core (pinned 1.103.0). Nothing was
read from or transliterated from the license-gated `litellm_enterprise`
package (LicenseRef-Proprietary): its features were audited from the outside
only; no code or text was taken from it.

The provider catalog (src/adapters/catalog-table.ts, W150) is a DATA
derivation: provider names, family mapping, tiering, and default env var
names derived from the MIT core's registries (LlmProviders enum,
llms/<provider>/chat dirs, llms/openai_like/providers.json) at build time,
2026-10-01, verified by an independent re-derivation (see the test's
membership check). No LiteLLM provider implementation code was copied for
the table; the row facts (names, endpoints category, env var names) are
documentation facts. The tier-2 adapters (azure-openai, bedrock, vertex)
are original implementations informed by the MIT code's architecture;
auth flows (Entra, SigV4, GCP jwt-bearer) follow the providers' published
protocols.
