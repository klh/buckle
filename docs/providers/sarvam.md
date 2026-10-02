> Source: https://docs.litellm.ai/docs/providers/sarvam  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Sarvam.ai"
url: "/docs/providers/sarvam"
canonical_url: "https://docs.litellm.ai/docs/providers/sarvam"
type: "docs"
last_updated: "2026-10-01"
summary: "LiteLLM supports all the text models from Sarvam ai"
related:
  - "/docs/providers/openrouter"
  - "/docs/providers/ovhcloud"
---
# Sarvam.ai

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


LiteLLM supports all the text models from [Sarvam ai](https://docs.sarvam.ai/api-reference-docs/chat/chat-completions)

## Usage

```python
import os
from litellm import completion

# Set your Sarvam API key
os.environ["SARVAM_API_KEY"] = ""

messages = [{"role": "user", "content": "Hello"}]

response = completion(
    model="sarvam/sarvam-m",
    messages=messages,
)
print(response)
```

## Usage with LiteLLM Proxy Server

Here's how to call a Sarvam.ai model with the LiteLLM Proxy Server

1. **Modify the `config.yaml`:**

    ```yaml
    model_list:
      - model_name: my-model
        litellm_params:
          model: sarvam/<your-model-name>  # add sarvam/ prefix to route as Sarvam provider
          api_key: api-key                 # api key to send your model
    ```

2. **Start the proxy:**

    ```bash
    $ litellm --config /path/to/config.yaml
    ```

3. **Send a request to LiteLLM Proxy Server:**

**OpenAI Python v1.0.0+**

    ```python
    import openai

    client = openai.OpenAI(
        api_key="sk-<your-litellm-api-key>",             # pass litellm proxy key, if you're using virtual keys
        base_url="http://0.0.0.0:4000" # litellm-proxy-base url
    )

    response = client.chat.completions.create(
        model="my-model",
        messages=[
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
        ]
    }'
    ```

## Related pages

- [OpenRouter](https://docs.litellm.ai/docs/providers/openrouter.md)
- [OVHCloud AI Endpoints](https://docs.litellm.ai/docs/providers/ovhcloud.md)
