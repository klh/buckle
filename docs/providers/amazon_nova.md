> Source: https://docs.litellm.ai/docs/providers/amazon_nova  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Amazon Nova"
url: "/docs/providers/amazon_nova"
canonical_url: "https://docs.litellm.ai/docs/providers/amazon_nova"
type: "docs"
last_updated: "2026-10-01"
summary: "| Property | Details |"
related:
  - "/docs/providers/aleph_alpha"
  - "/docs/providers/anyscale"
---
# Amazon Nova

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


| Property | Details |
|-------|-------|
| Description | Amazon Nova is a family of foundation models built by Amazon that deliver frontier intelligence and industry-leading price performance. |
| Provider Route on LiteLLM | `amazon_nova/` |
| Provider Doc | [Amazon Nova ↗](https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html) |
| Supported OpenAI Endpoints | `/chat/completions`, `v1/responses` |
| Other Supported Endpoints | `v1/messages`, `/generateContent` | 

## Authentication

Amazon Nova uses API key authentication. You can obtain your API key from the [Amazon Nova developer console ↗](https://nova.amazon.com/dev/documentation).

```bash
export AMAZON_NOVA_API_KEY="your-api-key"
```

## Usage

**SDK**

```python
import os
from litellm import completion

# Set your API key
os.environ["AMAZON_NOVA_API_KEY"] = "your-api-key"

response = completion(
    model="amazon_nova/nova-micro-v1",
    messages=[
        {"role": "system", "content": "You are a helpful assistant"},
        {"role": "user", "content": "Hello, how are you?"}
    ]
)

print(response)
```

**PROXY**

### 1. Setup config.yaml

```yaml
model_list:
  - model_name: amazon-nova-micro
    litellm_params:
      model: amazon_nova/nova-micro-v1
      api_key: os.environ/AMAZON_NOVA_API_KEY
```
### 2. Start the proxy
```bash
litellm --config /path/to/config.yaml
```

### 3. Test it

```bash
curl --location 'http://0.0.0.0:4000/chat/completions' \
--header 'Content-Type: application/json' \
--data '{
    "model": "amazon-nova-micro",
    "messages": [
        {
            "role": "user",
            "content": "Hello, how are you?"
        }
    ]
}'
```

## Supported Models

| Model Name | Usage | Context Window |
|------------|-------|----------------|
| Nova Micro | `completion(model="amazon_nova/nova-micro-v1", messages=messages)` | 128K tokens |
| Nova Lite | `completion(model="amazon_nova/nova-lite-v1", messages=messages)` | 300K tokens |
| Nova Pro | `completion(model="amazon_nova/nova-pro-v1", messages=messages)` | 300K tokens |
| Nova Premier | `completion(model="amazon_nova/nova-premier-v1", messages=messages)` | 1M tokens |

## Usage - Streaming

**SDK**

```python
import os
from litellm import completion

os.environ["AMAZON_NOVA_API_KEY"] = "your-api-key"

response = completion(
    model="amazon_nova/nova-micro-v1",
    messages=[
        {"role": "system", "content": "You are a helpful assistant"},
        {"role": "user", "content": "Tell me about machine learning"}
    ],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

**PROXY**

```bash
curl --location 'http://0.0.0.0:4000/chat/completions' \
--header 'Content-Type: application/json' \
--data '{
    "model": "amazon-nova-micro",
    "messages": [
        {
            "role": "user",
            "content": "Tell me about machine learning"
        }
    ],
    "stream": true
}'
```

## Usage - Function Calling / Tool Usage

**SDK**

```python
import os
from litellm import completion

os.environ["AMAZON_NOVA_API_KEY"] = "your-api-key"

tools = [
    {
        "type": "function",
        "function": {
            "name": "getCurrentWeather",
            "description": "Get the current weather in a given city",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City and country e.g. San Francisco, CA"
                    }
                },
                "required": ["location"]
            }
        }
    }
]

response = completion(
    model="amazon_nova/nova-micro-v1",
    messages=[
        {"role": "user", "content": "What's the weather like in San Francisco?"}
    ],
    tools=tools
)

print(response)
```

**PROXY**

```bash
curl --location 'http://0.0.0.0:4000/chat/completions' \
--header 'Content-Type: application/json' \
--data '{
    "model": "amazon-nova-micro",
    "messages": [
        {
            "role": "user",
            "content": "What'\''s the weather like in San Francisco?"
        }
    ],
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "getCurrentWeather",
                "description": "Get the current weather in a given city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "City and country e.g. San Francisco, CA"
                        }
                    },
                    "required": ["location"]
                }
            }
        }
    ]
}'
```

## Set temperature, top_p, etc.

**SDK**

```python
import os
from litellm import completion

os.environ["AMAZON_NOVA_API_KEY"] = "your-api-key"

response = completion(
    model="amazon_nova/nova-pro-v1",
    messages=[
        {"role": "user", "content": "Write a creative story"}
    ],
    temperature=0.8,
    max_tokens=500,
    top_p=0.9
)

print(response)
```

**PROXY**

**Set on yaml**

```yaml
model_list:
  - model_name: amazon-nova-pro
    litellm_params:
      model: amazon_nova/nova-pro-v1
      temperature: 0.8
      max_tokens: 500
      top_p: 0.9
```
**Set on request**
```bash
curl --location 'http://0.0.0.0:4000/chat/completions' \
--header 'Content-Type: application/json' \
--data '{
    "model": "amazon-nova-pro",
    "messages": [
        {
            "role": "user",
            "content": "Write a creative story"
        }
    ],
    "temperature": 0.8,
    "max_tokens": 500,
    "top_p": 0.9
}'
```

## Model Comparison

| Model | Best For | Speed | Cost | Context |
|-------|----------|-------|------|---------|
| **Nova Micro** | Simple tasks, high throughput | Fastest | Lowest | 128K |
| **Nova Lite** | Balanced performance | Fast | Low | 300K |
| **Nova Pro** | Complex reasoning | Medium | Medium | 300K |
| **Nova Premier** | Most advanced tasks | Slower | Higher | 1M |

## Error Handling

Common error codes and their meanings:

- `401 Unauthorized`: Invalid API key
- `429 Too Many Requests`: Rate limit exceeded
- `400 Bad Request`: Invalid request format
- `500 Internal Server Error`: Service temporarily unavailable

## Related pages

- [Aleph Alpha](https://docs.litellm.ai/docs/providers/aleph_alpha.md)
- [Anyscale](https://docs.litellm.ai/docs/providers/anyscale.md)
