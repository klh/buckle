> Source: https://docs.litellm.ai/docs/providers/bedrock_rerank  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "AWS Bedrock - Rerank API"
url: "/docs/providers/bedrock_rerank"
canonical_url: "https://docs.litellm.ai/docs/providers/bedrock_rerank"
type: "docs"
last_updated: "2026-10-01"
summary: "Use Bedrock's Rerank API in the Cohere /rerank format."
related:
  - "/docs/providers/bedrock_image_gen"
  - "/docs/providers/bedrock_agentcore"
---
# AWS Bedrock - Rerank API

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


Use Bedrock's Rerank API in the Cohere `/rerank` format.

:::info[Cost Tracking]

✅ **Cost tracking is supported** for Bedrock Rerank API calls.

:::

## Supported Parameters

- `model` - the foundation model ARN
- `query` - the query to rerank against
- `documents` - the list of documents to rerank
- `top_n` - the number of results to return

## Usage

**SDK**

```python
from litellm import rerank
import os 

os.environ["AWS_ACCESS_KEY_ID"] = ""
os.environ["AWS_SECRET_ACCESS_KEY"] = ""
os.environ["AWS_REGION_NAME"] = ""

response = rerank(
    model="bedrock/arn:aws:bedrock:us-west-2::foundation-model/amazon.rerank-v1:0", # provide the model ARN - get this here https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/bedrock/client/list_foundation_models.html
    query="hello",
    documents=["hello", "world"],
    top_n=2,
)

print(response)
```

**PROXY**

### 1. Setup config.yaml

```yaml
model_list:
    - model_name: bedrock-rerank
      litellm_params:
        model: bedrock/arn:aws:bedrock:us-west-2::foundation-model/amazon.rerank-v1:0
        aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
        aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
        aws_region_name: os.environ/AWS_REGION_NAME
```

### 2. Start proxy server

```bash
litellm --config config.yaml

# RUNNING on http://0.0.0.0:4000
```

### 3. Test it! 

```bash
curl http://0.0.0.0:4000/rerank \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bedrock-rerank",
    "query": "What is the capital of the United States?",
    "documents": [
        "Carson City is the capital city of the American state of Nevada.",
        "The Commonwealth of the Northern Mariana Islands is a group of islands in the Pacific Ocean. Its capital is Saipan.",
        "Washington, D.C. is the capital of the United States.",
        "Capital punishment has existed in the United States since before it was a country."
    ],
    "top_n": 3

  }'
```

## Authentication

All standard Bedrock authentication methods are supported for rerank. See [Bedrock Authentication](./bedrock#boto3---authentication) for details.

## Related pages

- [AWS Bedrock - Image Generation](https://docs.litellm.ai/docs/providers/bedrock_image_gen.md)
- [Bedrock AgentCore](https://docs.litellm.ai/docs/providers/bedrock_agentcore.md)
