> Source: https://docs.litellm.ai/docs/providers/topaz  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Topaz"
url: "/docs/providers/topaz"
canonical_url: "https://docs.litellm.ai/docs/providers/topaz"
type: "docs"
last_updated: "2026-10-01"
summary: "| Property | Details |"
related:
  - "/docs/providers/togetherai"
  - "/docs/providers/triton-inference-server"
---
# Topaz

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


| Property | Details |
|-------|-------|
| Description | Professional-grade photo and video editing powered by AI. |
| Provider Route on LiteLLM | `topaz/` |
| Provider Doc | [Topaz ↗](https://www.topazlabs.com/enhance-api) |
| API Endpoint for Provider | https://api.topazlabs.com |
| Supported OpenAI Endpoints | `/image/variations` |

## Quick Start

```python
from litellm import image_variation
import os 

os.environ["TOPAZ_API_KEY"] = ""
response = image_variation(
    model="topaz/Standard V2", image=image_url
)
```

## Supported OpenAI Params

- `response_format`
- `size` (widthxheight)

## Related pages

- [Together AI](https://docs.litellm.ai/docs/providers/togetherai.md)
- [Triton Inference Server](https://docs.litellm.ai/docs/providers/triton-inference-server.md)
