> Source: https://docs.litellm.ai/docs/providers/text_completion_openai  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "OpenAI (Text Completion)"
url: "/docs/providers/text_completion_openai"
canonical_url: "https://docs.litellm.ai/docs/providers/text_completion_openai"
type: "docs"
last_updated: "2026-10-01"
summary: "LiteLLM supports OpenAI text completion models"
related:
  - "/docs/providers/openai/videos"
  - "/docs/providers/openai_compatible"
---
# OpenAI (Text Completion)

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


LiteLLM supports OpenAI text completion models

### Required API Keys

```python
import os 
os.environ["OPENAI_API_KEY"] = "your-api-key"
```

### Usage
```python
import os 
from litellm import completion

os.environ["OPENAI_API_KEY"] = "your-api-key"

# openai call
response = completion(
    model = "gpt-3.5-turbo-instruct", 
    messages=[{ "content": "Hello, how are you?","role": "user"}]
)
```

### Usage - LiteLLM Proxy Server

Here's how to call OpenAI models with the LiteLLM Proxy Server

### 1. Save key in your environment

```bash
export OPENAI_API_KEY=""
```

### 2. Start the proxy 

**config.yaml**

```yaml
model_list:
  - model_name: gpt-5.6-luna
    litellm_params:
      model: openai/gpt-5.6-luna                          # The `openai/` prefix will call openai.chat.completions.create
      api_key: os.environ/OPENAI_API_KEY
  - model_name: gpt-3.5-turbo-instruct
    litellm_params:
      model: text-completion-openai/gpt-3.5-turbo-instruct # The `text-completion-openai/` prefix will call openai.completions.create
      api_key: os.environ/OPENAI_API_KEY
```
**config.yaml - proxy all OpenAI models**

Use this to add all openai models with one API Key. **WARNING: This will not do any load balancing**
This means requests to `gpt-5.6-terra`, `gpt-5.6-luna` will all go through this route 

```yaml
model_list:
  - model_name: "*"             # all requests where model not in your config go to this deployment
    litellm_params:
      model: openai/*           # set `openai/` to use the openai route
      api_key: os.environ/OPENAI_API_KEY
```
**CLI**

```bash
$ litellm --model gpt-3.5-turbo-instruct

# Server running on http://0.0.0.0:4000
```

### 3. Test it

**Curl Request**

```shell
curl --location 'http://0.0.0.0:4000/chat/completions' \
--header 'Content-Type: application/json' \
--data ' {
      "model": "gpt-3.5-turbo-instruct",
      "messages": [
        {
          "role": "user",
          "content": "what llm are you"
        }
      ]
    }
'
```
**OpenAI v1.0.0+**

```python
import openai
client = openai.OpenAI(
    api_key="anything",
    base_url="http://0.0.0.0:4000"
)

# request sent to model set on litellm proxy, `litellm --model`
response = client.chat.completions.create(model="gpt-3.5-turbo-instruct", messages = [
    {
        "role": "user",
        "content": "this is a test request, write a short poem"
    }
])

print(response)

```
**Langchain**

```python
from langchain.chat_models import ChatOpenAI
from langchain.prompts.chat import (
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    SystemMessagePromptTemplate,
)
from langchain.schema import HumanMessage, SystemMessage

chat = ChatOpenAI(
    openai_api_base="http://0.0.0.0:4000", # set openai_api_base to the LiteLLM Proxy
    model = "gpt-3.5-turbo-instruct",
    temperature=0.1
)

messages = [
    SystemMessage(
        content="You are a helpful assistant that im using to make a test request to."
    ),
    HumanMessage(
        content="test from litellm. tell me why it's amazing in 1 sentence"
    ),
]
response = chat(messages)

print(response)
```

## OpenAI Text Completion Models / Instruct Models

| Model Name          | Function Call                                      |
|---------------------|----------------------------------------------------|
| gpt-3.5-turbo-instruct | `response = completion(model="gpt-3.5-turbo-instruct", messages=messages)` |
| gpt-3.5-turbo-instruct-0914 | `response = completion(model="gpt-3.5-turbo-instruct-0914", messages=messages)` |
| babbage-002         | `response = completion(model="babbage-002", messages=messages)` |
| davinci-002         | `response = completion(model="davinci-002", messages=messages)` |

## Related pages

- [OpenAI Video Generation](https://docs.litellm.ai/docs/providers/openai/videos.md)
- [OpenAI-Compatible Endpoints](https://docs.litellm.ai/docs/providers/openai_compatible.md)
