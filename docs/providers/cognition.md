> Source: https://docs.litellm.ai/docs/providers/cognition  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Cognition"
url: "/docs/providers/cognition"
canonical_url: "https://docs.litellm.ai/docs/providers/cognition"
type: "docs"
last_updated: "2026-10-01"
related:
  - "/docs/providers/codestral"
  - "/docs/providers/cohere"
---
# Cognition

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


## Overview

| Property | Details |
|-------|-------|
| Description | Cognition serves its SWE coding models over an OpenAI-compatible API |
| Provider Route on LiteLLM | `cognition/` |
| Link to Provider Doc | [Cognition Documentation](https://docs.devin.ai) |
| Default Base URL | `https://api.cognition.ai/v1` |
| Supported Operations | `/chat/completions`, `/messages` through LiteLLM's Anthropic Messages adapter |

Cognition is its own provider on LiteLLM rather than a generic OpenAI-compatible route, so its spend is priced from the Cognition cost map entries and reported under `cognition` instead of being pooled with OpenAI traffic

## API Key

```python showLineNumbers title="Environment Variables"
import os

os.environ["COGNITION_API_KEY"] = "your-api-key"
os.environ["COGNITION_API_BASE"] = "https://api.cognition.ai/v1"  # optional override
```

## Models

| Model | Input / 1M tokens | Output / 1M tokens | Cache read / 1M tokens |
|-------|-------------------|--------------------|------------------------|
| `cognition/swe-1.7` | $0.50 | $2.50 | $0.20 |
| `cognition/swe-1.7-lightning` | $2.50 | $12.50 | $1.00 |
| `cognition/swe-1.6` | $0.50 | $2.50 | $0.20 |

Pricing follows the [Cognition model list](https://docs.devin.ai/desktop/models). `swe-1.7` is the standard tier; `swe-1.7-lightning` is the Cerebras-served tier that answers at about 1000 tokens a second and costs 5x. If your contract prices differ, set `input_cost_per_token` / `output_cost_per_token` on the deployment and those override the cost map

## Usage - LiteLLM Python SDK

### Chat Completions

```python showLineNumbers title="Cognition Chat Completion"
import os
from litellm import completion

os.environ["COGNITION_API_KEY"] = "your-api-key"

response = completion(
    model="cognition/swe-1.7",
    messages=[{"role": "user", "content": "Write a python function that reverses a string"}],
)

print(response.choices[0].message.content)
```

### Streaming

```python showLineNumbers title="Cognition Streaming Chat Completion"
import os
from litellm import completion

os.environ["COGNITION_API_KEY"] = "your-api-key"

response = completion(
    model="cognition/swe-1.7",
    messages=[{"role": "user", "content": "Explain a binary search in two sentences"}],
    stream=True,
)

for chunk in response:
    print(chunk)
```

### Tool Calling

```python showLineNumbers title="Cognition Tool Calling"
import os
from litellm import completion

os.environ["COGNITION_API_KEY"] = "your-api-key"

tools = [
    {
        "type": "function",
        "function": {
            "name": "run_tests",
            "description": "Run the test suite for a package",
            "parameters": {
                "type": "object",
                "properties": {"package": {"type": "string", "description": "Package name"}},
                "required": ["package"],
            },
        },
    }
]

response = completion(
    model="cognition/swe-1.7",
    messages=[{"role": "user", "content": "Run the tests for the billing package"}],
    tools=tools,
    tool_choice="auto",
)

print(response.choices[0].message.tool_calls)
```

## Usage - LiteLLM Proxy

Add Cognition to your LiteLLM Proxy configuration:

```yaml showLineNumbers title="config.yaml"
model_list:
  - model_name: swe-1.7
    litellm_params:
      model: cognition/swe-1.7
      api_key: os.environ/COGNITION_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Start the proxy:

```bash showLineNumbers title="Start LiteLLM Proxy"
export COGNITION_API_KEY="your-api-key"
export LITELLM_MASTER_KEY="sk-local-cognition"
litellm --config config.yaml --port 4000

# RUNNING on http://0.0.0.0:4000
```

**OpenAI SDK**

```python showLineNumbers title="Cognition via Proxy - OpenAI SDK"
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4000",
    api_key="sk-local-cognition",
)

response = client.chat.completions.create(
    model="swe-1.7",
    messages=[{"role": "user", "content": "hello from litellm"}],
)

print(response.choices[0].message.content)
```

**cURL**

```bash showLineNumbers title="Cognition via Proxy - cURL"
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{
    "model": "swe-1.7",
    "messages": [{"role": "user", "content": "hello from litellm"}]
  }'
```

You can also add Cognition from the Admin UI. Go to Models, then Add Model, pick Cognition as the provider, choose one of the `cognition/` models, and paste your key

## Anthropic Messages Compatibility

LiteLLM translates Anthropic Messages-shaped requests into Cognition chat completions, both through the SDK facade and the proxy's `/v1/messages` endpoint:

```bash showLineNumbers title="Anthropic Messages through LiteLLM Proxy"
curl http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "swe-1.7",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "hello from litellm"}]
  }'
```

## Cost Tracking

The `cognition/` models are registered in LiteLLM's model cost map, so per-request spend is computed automatically, returned in the `x-litellm-response-cost` response header, and recorded in spend logs under provider `cognition`. Discounts and reports configured for OpenAI do not apply to this traffic

## Custom Endpoints

Cognition provisions API endpoints per customer today, so most deployments should set `COGNITION_API_BASE` or pass `api_base` explicitly with the base URL from your Cognition onboarding. `https://api.cognition.ai/v1` is the conventional default used when neither is set. The `cognition/` route keeps the provider identity and pricing either way

```yaml showLineNumbers title="config.yaml"
model_list:
  - model_name: swe-1.7
    litellm_params:
      model: cognition/swe-1.7
      api_base: https://your-cognition-endpoint/v1
      api_key: os.environ/COGNITION_API_KEY
```

## Related pages

- [Codestral API [Mistral AI]](https://docs.litellm.ai/docs/providers/codestral.md)
- [Cohere](https://docs.litellm.ai/docs/providers/cohere.md)
