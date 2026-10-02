> Source: https://docs.litellm.ai/docs/providers/petals  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Petals"
url: "/docs/providers/petals"
canonical_url: "https://docs.litellm.ai/docs/providers/petals"
type: "docs"
last_updated: "2026-10-01"
related:
  - "/docs/providers/perplexity_embedding"
  - "/docs/providers/poe"
---
# Petals

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt

Petals: https://github.com/bigscience-workshop/petals

<a target="_blank" href="https://colab.research.google.com/github/BerriAI/litellm/blob/main/cookbook/LiteLLM_Petals.ipynb">
[Image: Open In Colab]
</a>

## Pre-Requisites
Ensure you have `petals` installed
```shell
uv add git+https://github.com/bigscience-workshop/petals
```

## Usage
Ensure you add `petals/` as a prefix for all petals LLMs. This sets the custom_llm_provider to petals

```python
from litellm import completion

response = completion(
    model="petals/petals-team/StableBeluga2", 
    messages=[{ "content": "Hello, how are you?","role": "user"}]
)

print(response)
```

## Usage with Streaming

```python
response = completion(
    model="petals/petals-team/StableBeluga2", 
    messages=[{ "content": "Hello, how are you?","role": "user"}],
    stream=True
)

print(response)
for chunk in response:
  print(chunk)
```

### Model Details

| Model Name       | Function Call                              |
|------------------|--------------------------------------------|
| petals-team/StableBeluga | `completion('petals/petals-team/StableBeluga2', messages)` | 
| huggyllama/llama-65b | `completion('petals/huggyllama/llama-65b', messages)` |

## Related pages

- [Perplexity Embeddings](https://docs.litellm.ai/docs/providers/perplexity_embedding.md)
- [Poe](https://docs.litellm.ai/docs/providers/poe.md)
