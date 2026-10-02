> Source: https://docs.litellm.ai/docs/providers/abliteration  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Abliteration"
url: "/docs/providers/abliteration"
canonical_url: "https://docs.litellm.ai/docs/providers/abliteration"
type: "docs"
last_updated: "2026-10-01"
related:
  - "/docs/providers/litellm_proxy"
  - "/docs/providers/ai21"
---
# Abliteration

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


## Overview

| Property | Details |
|-------|-------|
| Description | Abliteration provides an OpenAI-compatible `/chat/completions` endpoint. |
| Provider Route on LiteLLM | `abliteration/` |
| Link to Provider Doc | [Abliteration](https://abliteration.ai) |
| Base URL | `https://api.abliteration.ai/v1` |
| Supported Operations | [`/chat/completions`](#sample-usage) |

<br />

## Required Variables

```python showLineNumbers title="Environment Variables"
os.environ["ABLITERATION_API_KEY"] = ""  # your Abliteration API key
```

## Sample Usage

```python showLineNumbers title="Abliteration Completion"
import os
from litellm import completion

os.environ["ABLITERATION_API_KEY"] = ""

response = completion(
    model="abliteration/abliterated-model",
    messages=[{"role": "user", "content": "Hello from LiteLLM"}],
)

print(response)
```

## Sample Usage - Streaming

```python showLineNumbers title="Abliteration Streaming Completion"
import os
from litellm import completion

os.environ["ABLITERATION_API_KEY"] = ""

response = completion(
    model="abliteration/abliterated-model",
    messages=[{"role": "user", "content": "Stream a short reply"}],
    stream=True,
)

for chunk in response:
    print(chunk)
```

## Usage with LiteLLM Proxy Server

1. Add the model to your proxy config:

```yaml showLineNumbers title="config.yaml"
model_list:
  - model_name: abliteration-chat
    litellm_params:
      model: abliteration/abliterated-model
      api_key: os.environ/ABLITERATION_API_KEY
```

2. Start the proxy:

```bash
litellm --config /path/to/config.yaml
```

## Direct API Usage (Bearer Token)

Use the environment variable as a Bearer token against the OpenAI-compatible endpoint:
`https://api.abliteration.ai/v1/chat/completions`.

```bash showLineNumbers title="cURL"
export ABLITERATION_API_KEY=""
curl https://api.abliteration.ai/v1/chat/completions \
  -H "Authorization: Bearer ${ABLITERATION_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "abliterated-model",
    "messages": [{"role": "user", "content": "Hello from Abliteration"}]
  }'
```

```python showLineNumbers title="Python (requests)"
import os
import requests

api_key = os.environ["ABLITERATION_API_KEY"]

response = requests.post(
    "https://api.abliteration.ai/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    },
    json={
        "model": "abliterated-model",
        "messages": [{"role": "user", "content": "Hello from Abliteration"}],
    },
    timeout=60,
)

print(response.json())
```

## Related pages

- [LiteLLM Proxy (LLM Gateway)](https://docs.litellm.ai/docs/providers/litellm_proxy.md)
- [AI21](https://docs.litellm.ai/docs/providers/ai21.md)
