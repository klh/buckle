> Source: https://docs.litellm.ai/docs/providers/lm_studio  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "LM Studio"
url: "/docs/providers/lm_studio"
canonical_url: "https://docs.litellm.ai/docs/providers/lm_studio"
type: "docs"
last_updated: "2026-10-01"
related:
  - "/docs/providers/llamagate"
  - "/docs/providers/manus"
---
# LM Studio

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


https://lmstudio.ai/docs/basics/server

:::tip

**We support ALL LM Studio models, just set `model=lm_studio/<any-model-on-lmstudio>` as a prefix when sending litellm requests**

:::

| Property | Details |
|-------|-------|
| Description | Discover, download, and run local LLMs. |
| Provider Route on LiteLLM | `lm_studio/` |
| Provider Doc | [LM Studio ↗](https://lmstudio.ai/docs/api/openai-api) |
| Supported OpenAI Endpoints | `/chat/completions`, `/embeddings`, `/completions` |

## API Key
```python
# env variable
os.environ['LM_STUDIO_API_BASE']
os.environ['LM_STUDIO_API_KEY'] # optional, default is empty
```

## Sample Usage
```python
from litellm import completion
import os

os.environ['LM_STUDIO_API_BASE'] = ""

response = completion(
    model="lm_studio/llama-3-8b-instruct",
    messages=[
        {
            "role": "user",
            "content": "What's the weather like in Boston today in Fahrenheit?",
        }
    ]
)
print(response)
```

## Sample Usage - Streaming
```python
from litellm import completion
import os

os.environ['LM_STUDIO_API_KEY'] = ""
response = completion(
    model="lm_studio/llama-3-8b-instruct",
    messages=[
        {
            "role": "user",
            "content": "What's the weather like in Boston today in Fahrenheit?",
        }
    ],
    stream=True,
)

for chunk in response:
    print(chunk)
```

## Usage with LiteLLM Proxy Server

Here's how to call a LM Studio model with the LiteLLM Proxy Server

1. Modify the config.yaml 

  ```yaml
  model_list:
    - model_name: my-model
      litellm_params:
        model: lm_studio/<your-model-name>  # add lm_studio/ prefix to route as LM Studio provider
        api_key: api-key                 # api key to send your model
  ```

2. Start the proxy 

  ```bash
  $ litellm --config /path/to/config.yaml
  ```

3. Send Request to LiteLLM Proxy Server

**OpenAI Python v1.0.0+**

  ```python
  import openai
  client = openai.OpenAI(
      api_key="sk-<your-litellm-api-key>",             # pass litellm proxy key, if you're using virtual keys
      base_url="http://0.0.0.0:4000" # litellm-proxy-base url
  )

  response = client.chat.completions.create(
      model="my-model",
      messages = [
          {
              "role": "user",
              "content": "what llm are you"
          }
      ],
  )

  print(response)
  ```

**curl**

  ```shell
  curl --location 'http://0.0.0.0:4000/chat/completions' \
      --header "Authorization: Bearer $LITELLM_API_KEY" \
      --header 'Content-Type: application/json' \
      --data '{
      "model": "my-model",
      "messages": [
          {
          "role": "user",
          "content": "what llm are you"
          }
      ],
  }'
  ```

## Supported Parameters

See [Supported Parameters](../completion/input.md#translated-openai-params) for supported parameters.

## Embedding

```python
from litellm import embedding
import os 

os.environ['LM_STUDIO_API_BASE'] = "http://localhost:8000"
response = embedding(
    model="lm_studio/jina-embeddings-v3",
    input=["Hello world"],
)
print(response)
```

## Structured Output

LM Studio supports structured outputs via JSON Schema. You can pass a pydantic model or a raw schema using `response_format`.
LiteLLM sends the schema as `{ "type": "json_schema", "json_schema": {"schema": <your schema>} }`.

```python
from pydantic import BaseModel
from litellm import completion

class Book(BaseModel):
    title: str
    author: str
    year: int

response = completion(
    model="lm_studio/llama-3-8b-instruct",
    messages=[{"role": "user", "content": "Tell me about The Hobbit"}],
    response_format=Book,
)
print(response.choices[0].message.content)
```

## Related pages

- [LlamaGate](https://docs.litellm.ai/docs/providers/llamagate.md)
- [Manus](https://docs.litellm.ai/docs/providers/manus.md)
