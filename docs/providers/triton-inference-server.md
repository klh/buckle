> Source: https://docs.litellm.ai/docs/providers/triton-inference-server  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Triton Inference Server"
url: "/docs/providers/triton-inference-server"
canonical_url: "https://docs.litellm.ai/docs/providers/triton-inference-server"
type: "docs"
last_updated: "2026-10-01"
summary: "LiteLLM supports Embedding Models on Triton Inference Servers"
related:
  - "/docs/providers/topaz"
  - "/docs/providers/v0"
---
# Triton Inference Server

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


LiteLLM supports Embedding Models on Triton Inference Servers

| Property | Details |
|-------|-------|
| Description | NVIDIA Triton Inference Server |
| Provider Route on LiteLLM | `triton/` |
| Supported Operations | `/chat/completion`, `/completion`, `/embedding` |
| Supported Triton endpoints | `/infer`, `/generate`, `/embeddings` |
| Link to Provider Doc | [Triton Inference Server ↗](https://developer.nvidia.com/triton-inference-server) |

## Triton `/generate` - Chat Completion 

**SDK**

Use the `triton/` prefix to route to triton server
```python
from litellm import completion
response = completion(
    model="triton/llama-3-8b-instruct",
    messages=[{"role": "user", "content": "who are u?"}],
    max_tokens=10,
    api_base="http://localhost:8000/generate",
)
```

**PROXY**

1. Add models to your config.yaml

  ```yaml
  model_list:
    - model_name: my-triton-model
      litellm_params:
        model: triton/<your-triton-model>"
        api_base: https://your-triton-api-base/triton/generate
  ```

2. Start the proxy 

  ```bash
  $ litellm --config /path/to/config.yaml --detailed_debug
  ```

3. Send Request to LiteLLM Proxy Server

**OpenAI Python v1.0.0+**

    ```python
    import openai
    from openai import OpenAI

    # set base_url to your proxy server
    # set api_key to send to proxy server
    client = OpenAI(api_key="<proxy-api-key>", base_url="http://0.0.0.0:4000")

    response = client.chat.completions.create(
        model="my-triton-model",
        messages=[{"role": "user", "content": "who are u?"}],
        max_tokens=10,
    )

    print(response)

    ```

**curl**

  `--header` is optional, only required if you're using litellm proxy with Virtual Keys

    ```shell
    curl --location 'http://0.0.0.0:4000/chat/completions' \
    --header 'Content-Type: application/json' \
    --header "Authorization: Bearer $LITELLM_API_KEY" \
    --data ' {
    "model": "my-triton-model",
    "messages": [{"role": "user", "content": "who are u?"}]
    }'

    ```

## Triton `/infer` - Chat Completion 

**SDK**

Use the `triton/` prefix to route to triton server
```python
from litellm import completion

response = completion(
    model="triton/llama-3-8b-instruct",
    messages=[{"role": "user", "content": "who are u?"}],
    max_tokens=10,
    api_base="http://localhost:8000/infer",
)
```

**PROXY**

1. Add models to your config.yaml

  ```yaml
  model_list:
    - model_name: my-triton-model
      litellm_params:
        model: triton/<your-triton-model>"
        api_base: https://your-triton-api-base/triton/infer
  ```

2. Start the proxy 

  ```bash
  $ litellm --config /path/to/config.yaml --detailed_debug
  ```

3. Send Request to LiteLLM Proxy Server

**OpenAI Python v1.0.0+**

    ```python
    import openai
    from openai import OpenAI

    # set base_url to your proxy server
    # set api_key to send to proxy server
    client = OpenAI(api_key="<proxy-api-key>", base_url="http://0.0.0.0:4000")

    response = client.chat.completions.create(
        model="my-triton-model",
        messages=[{"role": "user", "content": "who are u?"}],
        max_tokens=10,
    )

    print(response)

    ```

**curl**

  `--header` is optional, only required if you're using litellm proxy with Virtual Keys

    ```shell
    curl --location 'http://0.0.0.0:4000/chat/completions' \
    --header 'Content-Type: application/json' \
    --header "Authorization: Bearer $LITELLM_API_KEY" \
    --data ' {
    "model": "my-triton-model",
    "messages": [{"role": "user", "content": "who are u?"}]
    }'

    ```

## Triton `/embeddings` - Embedding

**SDK**

Use the `triton/` prefix to route to triton server
```python
import litellm
import os

response = await litellm.aembedding(
    model="triton/<your-triton-model>",                                                       
    api_base="https://your-triton-api-base/triton/embeddings", # /embeddings endpoint you want litellm to call on your server
    input=["good morning from litellm"],
)
```

**PROXY**

1. Add models to your config.yaml

  ```yaml
  model_list:
    - model_name: my-triton-model
      litellm_params:
        model: triton/<your-triton-model>"
        api_base: https://your-triton-api-base/triton/embeddings
  ```

2. Start the proxy 

  ```bash
  $ litellm --config /path/to/config.yaml --detailed_debug
  ```

3. Send Request to LiteLLM Proxy Server

**OpenAI Python v1.0.0+**

    ```python
    import openai
    from openai import OpenAI

    # set base_url to your proxy server
    # set api_key to send to proxy server
    client = OpenAI(api_key="<proxy-api-key>", base_url="http://0.0.0.0:4000")

    response = client.embeddings.create(
        input=["hello from litellm"],
        model="my-triton-model"
    )

    print(response)

    ```

**curl**

  `--header` is optional, only required if you're using litellm proxy with Virtual Keys

    ```shell
    curl --location 'http://0.0.0.0:4000/embeddings' \
    --header 'Content-Type: application/json' \
    --header "Authorization: Bearer $LITELLM_API_KEY" \
    --data ' {
    "model": "my-triton-model",
    "input": ["write a litellm poem"]
    }'

    ```

## Related pages

- [Topaz](https://docs.litellm.ai/docs/providers/topaz.md)
- [v0](https://docs.litellm.ai/docs/providers/v0.md)
