> Source: https://docs.litellm.ai/docs/providers/watsonx/rerank  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "watsonx.ai Rerank"
url: "/docs/providers/watsonx/rerank"
canonical_url: "https://docs.litellm.ai/docs/providers/watsonx/rerank"
type: "docs"
last_updated: "2026-10-01"
---
# watsonx.ai Rerank

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


## Overview

| Property | Details                                                                  |
|----------|--------------------------------------------------------------------------|
| Description | watsonx.ai rerank integration                                            |
| Provider Route on LiteLLM | `watsonx/`                                                               |
| Supported Operations | `/ml/v1/text/rerank`                                                     |
| Link to Provider Doc | [IBM WatsonX.ai ↗](https://cloud.ibm.com/apidocs/watsonx-ai#text-rerank) |

## Quick Start

### **LiteLLM SDK**

```python
import os
from litellm import rerank

os.environ["WATSONX_APIKEY"] = "YOUR_WATSONX_APIKEY"
os.environ["WATSONX_API_BASE"] = "YOUR_WATSONX_API_BASE"
os.environ["WATSONX_PROJECT_ID"] = "YOUR_WATSONX_PROJECT_ID"

query="Best programming language for beginners?"
documents=[
    "Python is great for beginners due to simple syntax.",
    "JavaScript runs in browsers and is versatile.",
    "Rust has a steep learning curve but is very safe.",
]

response = rerank(
    model="watsonx/cross-encoder/ms-marco-minilm-l-12-v2",
    query=query,
    documents=documents,
    top_n=2,
    return_documents=True,
)

print(response)
```

### **LiteLLM Proxy**

```yaml
model_list:
  - model_name: cross-encoder/ms-marco-minilm-l-12-v2
    litellm_params:
      model: watsonx/cross-encoder/ms-marco-minilm-l-12-v2
      api_key: os.environ/WATSONX_APIKEY
      api_base: os.environ/WATSONX_API_BASE
      project_id: os.environ/WATSONX_PROJECT_ID
```
