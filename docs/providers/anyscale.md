> Source: https://docs.litellm.ai/docs/providers/anyscale  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Anyscale"
url: "/docs/providers/anyscale"
canonical_url: "https://docs.litellm.ai/docs/providers/anyscale"
type: "docs"
last_updated: "2026-10-01"
related:
  - "/docs/providers/amazon_nova"
  - "/docs/providers/apertis"
---
# Anyscale

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt

https://app.endpoints.anyscale.com/

## API Key
```python
# env variable
os.environ['ANYSCALE_API_KEY']
```

## Sample Usage
```python
from litellm import completion
import os

os.environ['ANYSCALE_API_KEY'] = ""
response = completion(
    model="anyscale/mistralai/Mistral-7B-Instruct-v0.1", 
    messages=messages
)
print(response)
```

## Sample Usage - Streaming
```python
from litellm import completion
import os

os.environ['ANYSCALE_API_KEY'] = ""
response = completion(
    model="anyscale/mistralai/Mistral-7B-Instruct-v0.1", 
    messages=messages,
    stream=True
)

for chunk in response:
    print(chunk)
```

## Supported Models
All models listed here https://app.endpoints.anyscale.com/ are supported. We actively maintain the list of models, pricing, token window, etc. [here](https://github.com/BerriAI/litellm/blob/31fbb095c2c365ef30caf132265fe12cff0ef153/model_prices_and_context_window.json#L957).

| Model Name               | Function Call                                                                                                                                                      |
|--------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| llama2-7b-chat | `completion(model="anyscale/meta-llama/Llama-2-7b-chat-hf", messages)` | 
| llama-2-13b-chat | `completion(model="anyscale/meta-llama/Llama-2-13b-chat-hf", messages)` | 
| llama-2-70b-chat | `completion(model="anyscale/meta-llama/Llama-2-70b-chat-hf", messages)` | 
| mistral-7b-instruct | `completion(model="anyscale/mistralai/Mistral-7B-Instruct-v0.1", messages)` | 
| CodeLlama-34b-Instruct | `completion(model="anyscale/codellama/CodeLlama-34b-Instruct-hf", messages)` |

## Related pages

- [Amazon Nova](https://docs.litellm.ai/docs/providers/amazon_nova.md)
- [Apertis AI (Stima API)](https://docs.litellm.ai/docs/providers/apertis.md)
