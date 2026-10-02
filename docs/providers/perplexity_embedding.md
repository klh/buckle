> Source: https://docs.litellm.ai/docs/providers/perplexity_embedding  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Perplexity Embeddings"
url: "/docs/providers/perplexity_embedding"
canonical_url: "https://docs.litellm.ai/docs/providers/perplexity_embedding"
type: "docs"
last_updated: "2026-10-01"
related:
  - "/docs/providers/perplexity"
  - "/docs/providers/petals"
---
# Perplexity Embeddings

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


https://docs.perplexity.ai/docs/embeddings/quickstart

LiteLLM supports Perplexity's pplx-embed embedding models for web-scale text retrieval.

## API Key

```python
# env variable
os.environ['PERPLEXITYAI_API_KEY']
```

## Sample Usage - Embedding

**SDK**

```python
from litellm import embedding
import os

os.environ['PERPLEXITYAI_API_KEY'] = ""

response = embedding(
    model="perplexity/pplx-embed-v1-0.6b",
    input=["good morning from litellm"],
)
print(response)
```

**Proxy**

1. Setup config.yaml

```yaml
model_list:
  - model_name: pplx-embed-v1-0.6b
    litellm_params:
      model: perplexity/pplx-embed-v1-0.6b
      api_key: os.environ/PERPLEXITYAI_API_KEY
  - model_name: pplx-embed-v1-4b
    litellm_params:
      model: perplexity/pplx-embed-v1-4b
      api_key: os.environ/PERPLEXITYAI_API_KEY
```

2. Start proxy

```bash
litellm --config /path/to/config.yaml
```

3. Test it!

```bash
curl http://0.0.0.0:4000/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -d '{
    "model": "pplx-embed-v1-0.6b",
    "input": ["good morning from litellm"]
  }'
```

## Supported Parameters

Perplexity embeddings support the following optional parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `dimensions` | int | Output embedding dimensions. 128–1024 for 0.6b models, 128–2560 for 4b models. Defaults to max. |
| `encoding_format` | string | `"base64_int8"` (default) or `"base64_binary"` for compressed output. |

### Example with Parameters

**SDK**

```python
from litellm import embedding
import os

os.environ['PERPLEXITYAI_API_KEY'] = ""

response = embedding(
    model="perplexity/pplx-embed-v1-4b",
    input=["Your text here"],
    dimensions=512,
)
print(f"Embedding dimensions: {len(response.data[0]['embedding'])}")
```

**Proxy**

```bash
curl http://0.0.0.0:4000/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -d '{
    "model": "pplx-embed-v1-4b",
    "input": ["Your text here"],
    "dimensions": 512
  }'
```

## Supported Models

All models listed on the [Perplexity Embeddings docs](https://docs.perplexity.ai/docs/embeddings/quickstart) are supported. Use `model=perplexity/<model-name>`.

| Model Name | Dimensions | Max Tokens | Price (per 1M tokens) | Function Call |
|---|---|---|---|---|
| pplx-embed-v1-0.6b | 1024 | 32K | $0.004 | `embedding(model="perplexity/pplx-embed-v1-0.6b", input)` |
| pplx-embed-v1-4b | 2560 | 32K | $0.03 | `embedding(model="perplexity/pplx-embed-v1-4b", input)` |

### Key Specifications

- **Max texts per request:** 512
- **Max tokens per input:** 32,768
- **Combined request limit:** 120,000 tokens
- **Matryoshka dimension reduction** — reduce dimensions to 128+ for faster search and reduced storage
- **No instruction prefix required** — embed text directly
- **Unnormalized embeddings** — use cosine similarity for comparison

## Related pages

- [Perplexity AI (pplx-api)](https://docs.litellm.ai/docs/providers/perplexity.md)
- [Petals](https://docs.litellm.ai/docs/providers/petals.md)
