> Source: https://docs.litellm.ai/docs/providers/qwencloud  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "QwenCloud and Qianwen AI Platform (Qwen models)"
url: "/docs/providers/qwencloud"
canonical_url: "https://docs.litellm.ai/docs/providers/qwencloud"
type: "docs"
last_updated: "2026-10-01"
summary: "Alibaba unified its model platform brands (DashScope, Bailian, Model Studio) under QwenCloud outside mainland China and Qianwen AI Platform in mainland China. LiteLLM routes both brands through its existing DashScope implementation, and..."
related:
  - "/docs/providers/pydantic_ai_agent"
  - "/docs/providers/ragflow"
---
# QwenCloud and Qianwen AI Platform (Qwen models)

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


Alibaba unified its model platform brands (DashScope, Bailian, Model Studio) under [QwenCloud](https://www.qwencloud.com/) outside mainland China and [Qianwen AI Platform](https://www.qianwenai.com/) in mainland China. LiteLLM routes both brands through its existing DashScope implementation, and the legacy `dashscope/` prefix keeps working as an alias

## Overview

| Property | Details |
|-------|-------|
| Description | Alibaba's Qwen model platform, served over an OpenAI-compatible API |
| Provider Routes on LiteLLM | `qwencloud/` (international), `qwen_ai_platform/` (mainland China), `dashscope/` (legacy alias) |
| Link to Provider Doc | [QwenCloud Documentation](https://docs.qwencloud.com/developer-guides/getting-started/introduction), [Qianwen AI Platform Documentation](https://platform.qianwenai.com/docs/developer-guides/getting-started/first-api-call) |
| Supported Operations | `/chat/completions`, `/embeddings`, `/rerank`, `/images/generations` |

These routes support pay-as-you-go API keys. Token Plan and Coding Plan endpoints are not yet mapped in LiteLLM (tracked on [issue #36150](https://github.com/BerriAI/litellm/issues/36150))

## QwenCloud (international)

Use the `qwencloud/` prefix outside mainland China

| Setting | Value |
|-------|-------|
| Prefix | `qwencloud/` |
| Default API base | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Rerank endpoint | `https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks` |
| Image generation endpoint | `https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |
| API key env var | `QWENCLOUD_API_KEY` (falls back to `DASHSCOPE_API_KEY`) |
| Base URL overrides | `QWENCLOUD_API_BASE`, `QWENCLOUD_API_BASE_RERANK`, `QWENCLOUD_API_BASE_IMAGE` |

## Qianwen AI Platform (mainland China)

Use the `qwen_ai_platform/` prefix in mainland China. It hits the same paths on the mainland host

| Setting | Value |
|-------|-------|
| Prefix | `qwen_ai_platform/` |
| Default API base | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Rerank endpoint | `https://dashscope.aliyuncs.com/compatible-api/v1/reranks` |
| Image generation endpoint | `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |
| API key env var | `QWEN_AI_PLATFORM_API_KEY` (falls back to `DASHSCOPE_API_KEY`) |
| Base URL overrides | `QWEN_AI_PLATFORM_API_BASE`, `QWEN_AI_PLATFORM_API_BASE_RERANK`, `QWEN_AI_PLATFORM_API_BASE_IMAGE` |

## API Key

```python showLineNumbers title="Environment Variables"
import os

os.environ["QWENCLOUD_API_KEY"] = "your-api-key"
```

For mainland China set `QWEN_AI_PLATFORM_API_KEY` instead. Both prefixes also read `DASHSCOPE_API_KEY` when their own key is not set, so existing DashScope credentials work without changes

## Models

Both prefixes accept any model from the DashScope catalog, for example `qwencloud/qwen-max`, `qwencloud/qwen-flash`, `qwencloud/qwen-image-3.0`, or `qwen_ai_platform/qwen-plus`. See the [DashScope page](./dashscope) for the model list

## Usage - LiteLLM Python SDK

### Chat Completions

```python showLineNumbers title="QwenCloud Chat Completion"
import os
from litellm import completion

os.environ["QWENCLOUD_API_KEY"] = "your-api-key"

response = completion(
    model="qwencloud/qwen-max",
    messages=[{"role": "user", "content": "hello from litellm"}],
)

print(response.choices[0].message.content)
```

### Streaming

```python showLineNumbers title="QwenCloud Streaming Chat Completion"
import os
from litellm import completion

os.environ["QWENCLOUD_API_KEY"] = "your-api-key"

response = completion(
    model="qwencloud/qwen-flash",
    messages=[{"role": "user", "content": "hello from litellm"}],
    stream=True,
)

for chunk in response:
    print(chunk)
```

### Embedding

```python showLineNumbers title="QwenCloud Embedding"
import os
from litellm import embedding

os.environ["QWENCLOUD_API_KEY"] = "your-api-key"

response = embedding(
    model="qwencloud/text-embedding-v4",
    input=["hello from litellm"],
)

print(response.data[0]["embedding"][:5])
```

### Rerank

```python showLineNumbers title="QwenCloud Rerank"
import os
from litellm import rerank

os.environ["QWENCLOUD_API_KEY"] = "your-api-key"

response = rerank(
    model="qwencloud/gte-rerank-v2",
    query="What is the capital of France?",
    documents=["Paris is the capital of France", "Berlin is the capital of Germany"],
)

print(response.results)
```

### Image Generation

```python showLineNumbers title="QwenCloud Image Generation"
import os
from litellm import image_generation

os.environ["QWENCLOUD_API_KEY"] = "your-api-key"

response = image_generation(
    model="qwencloud/qwen-image-3.0",
    prompt="A cup of coffee on a wooden table",
)

print(response.data[0].url)
```

## Usage - LiteLLM Proxy

Add the models to your LiteLLM Proxy configuration:

```yaml showLineNumbers title="config.yaml"
model_list:
  - model_name: qwen-max
    litellm_params:
      model: qwencloud/qwen-max
      api_key: os.environ/QWENCLOUD_API_KEY
  - model_name: qwen-plus-cn
    litellm_params:
      model: qwen_ai_platform/qwen-plus
      api_key: os.environ/QWEN_AI_PLATFORM_API_KEY
```

Start the proxy:

```bash showLineNumbers title="Start LiteLLM Proxy"
export QWENCLOUD_API_KEY="your-api-key"
litellm --config config.yaml --port 4000
```

**OpenAI SDK**

```python showLineNumbers title="QwenCloud via Proxy - OpenAI SDK"
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4000",
    api_key="your-litellm-key",
)

response = client.chat.completions.create(
    model="qwen-max",
    messages=[{"role": "user", "content": "hello from litellm"}],
)

print(response.choices[0].message.content)
```

**cURL**

```bash showLineNumbers title="QwenCloud via Proxy - cURL"
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "hello from litellm"}]
  }'
```

## Backward Compatibility with DashScope

The `dashscope/` prefix, `DASHSCOPE_API_KEY`, `DASHSCOPE_API_BASE`, and every existing DashScope config keep working unchanged. `qwencloud/` and `qwen_ai_platform/` are aliases over the same implementation, so no migration is needed: switch prefixes whenever it suits you, or not at all

## Related pages

- [Pydantic AI Agents](https://docs.litellm.ai/docs/providers/pydantic_ai_agent.md)
- [RAGFlow](https://docs.litellm.ai/docs/providers/ragflow.md)
