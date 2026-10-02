> Source: https://docs.litellm.ai/docs/providers/aleph_alpha  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Aleph Alpha"
url: "/docs/providers/aleph_alpha"
canonical_url: "https://docs.litellm.ai/docs/providers/aleph_alpha"
type: "docs"
last_updated: "2026-10-01"
summary: "LiteLLM supports all models from Aleph Alpha."
related:
  - "/docs/providers/aiml"
  - "/docs/providers/amazon_nova"
---
# Aleph Alpha

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


LiteLLM supports all models from [Aleph Alpha](https://www.aleph-alpha.com/). 

Like AI21 and Cohere, you can use these models without a waitlist. 

### API KEYS
```python
import os
os.environ["ALEPHALPHA_API_KEY"] = ""
```

### Aleph Alpha Models
https://www.aleph-alpha.com/

| Model Name       | Function Call                                  | Required OS Variables              |
|------------------|--------------------------------------------|------------------------------------|
| luminous-base       | `completion(model='luminous-base', messages=messages)`         | `os.environ['ALEPHALPHA_API_KEY']`     |
| luminous-base-control       | `completion(model='luminous-base-control', messages=messages)`         | `os.environ['ALEPHALPHA_API_KEY']`     |
| luminous-extended       | `completion(model='luminous-extended', messages=messages)`         | `os.environ['ALEPHALPHA_API_KEY']`     |
| luminous-extended-control       | `completion(model='luminous-extended-control', messages=messages)`         | `os.environ['ALEPHALPHA_API_KEY']`     |
| luminous-supreme     | `completion(model='luminous-supreme', messages=messages)`         | `os.environ['ALEPHALPHA_API_KEY']`     |
| luminous-supreme-control     | `completion(model='luminous-supreme-control', messages=messages)`         | `os.environ['ALEPHALPHA_API_KEY']`     |

## Related pages

- [AI/ML API](https://docs.litellm.ai/docs/providers/aiml.md)
- [Amazon Nova](https://docs.litellm.ai/docs/providers/amazon_nova.md)
