> Source: https://docs.litellm.ai/docs/providers/gemini/music  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Gemini Lyria (music generation)"
url: "/docs/providers/gemini/music"
canonical_url: "https://docs.litellm.ai/docs/providers/gemini/music"
type: "docs"
last_updated: "2026-10-01"
summary: "Google Lyria 3 preview models are listed in LiteLLM’s model cost map under the gemini/ provider for metadata and spend tracking."
related:
  - "/docs/providers/gemini/videos"
  - "/docs/providers/gemini_file_search"
---
# Gemini Lyria (music generation)

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


Google Lyria 3 preview models are listed in LiteLLM’s [model cost map](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) under the `gemini/` provider for metadata and spend tracking.

| Property | Details |
|----------|---------|
| Provider route | `gemini/` |
| Models | `gemini/lyria-3-clip-preview`, `gemini/lyria-3-pro-preview` |
| Provider docs | [Gemini API pricing / models ↗](https://ai.google.dev/gemini-api/docs/pricing) |

## Models

| Model | Notes |
|-------|--------|
| `gemini/lyria-3-clip-preview` | ~30s clip; paid tier listed as per generated song in Google’s pricing |
| `gemini/lyria-3-pro-preview` | Full song; paid tier listed as per generated song in Google’s pricing |

Input context limit in the cost map: **131,072** tokens. For modalities, limits, and features, see [Google’s Gemini API docs ↗](https://ai.google.dev/gemini-api/docs/models).

## LiteLLM behavior

- **Cost map**: Per-song paid pricing is stored as `output_cost_per_image` on those entries (flat per generation unit). Token-based completion cost may not reflect music billing until a dedicated path exists.
- **API calls**: Use the Gemini API as documented by Google. LiteLLM does not ship a separate `music_generation` helper like Veo’s `video_generation`.

## Auth

Same as other Gemini API models: `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

## Related pages

- [Gemini Video Generation (Veo)](https://docs.litellm.ai/docs/providers/gemini/videos.md)
- [Gemini File Search](https://docs.litellm.ai/docs/providers/gemini_file_search.md)
