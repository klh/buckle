> Source: https://docs.litellm.ai/docs/providers/watsonx/audio_transcription  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "WatsonX Audio Transcription"
url: "/docs/providers/watsonx/audio_transcription"
canonical_url: "https://docs.litellm.ai/docs/providers/watsonx/audio_transcription"
type: "docs"
last_updated: "2026-10-01"
related:
  - "/docs/providers/watsonx/"
  - "/docs/providers/xai"
---
# WatsonX Audio Transcription

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


## Overview

| Property | Details |
|----------|---------|
| Description | WatsonX audio transcription using Whisper models for speech-to-text |
| Provider Route on LiteLLM | `watsonx/` |
| Supported Operations | `/v1/audio/transcriptions` |
| Link to Provider Doc | [IBM WatsonX.ai ↗](https://www.ibm.com/watsonx) |

## Quick Start

### **LiteLLM SDK**

```python showLineNumbers title="transcription.py"
import litellm

response = litellm.transcription(
    model="watsonx/whisper-large-v3-turbo",
    file=open("audio.mp3", "rb"),
    api_base="https://us-south.ml.cloud.ibm.com",
    api_key="your-api-key",
    project_id="your-project-id"
)
print(response.text)
```

### **LiteLLM Proxy**

```yaml showLineNumbers title="config.yaml"
model_list:
  - model_name: whisper-large-v3-turbo
    litellm_params:
      model: watsonx/whisper-large-v3-turbo
      api_key: os.environ/WATSONX_APIKEY
      api_base: os.environ/WATSONX_URL
      project_id: os.environ/WATSONX_PROJECT_ID
```

```bash title="Request"
curl http://localhost:4000/v1/audio/transcriptions \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -F file="@audio.mp3" \
  -F model="whisper-large-v3-turbo"
```

## Supported Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Model ID (e.g., `watsonx/whisper-large-v3-turbo`) |
| `file` | file | Audio file to transcribe |
| `language` | string | Language code (e.g., `en`) |
| `prompt` | string | Optional prompt to guide transcription |
| `temperature` | float | Sampling temperature (0-1) |
| `response_format` | string | `json`, `text`, `srt`, `verbose_json`, `vtt` |

## Related pages

- [IBM watsonx.ai](https://docs.litellm.ai/docs/providers/watsonx/index.md)
- [xAI](https://docs.litellm.ai/docs/providers/xai.md)
