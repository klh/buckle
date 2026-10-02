> Source: https://docs.litellm.ai/docs/providers/deepgram  (fetched 2026-10-02)
> LiteLLM docs — MIT-licensed project, vendored for offline reference.

---
title: "Deepgram"
url: "/docs/providers/deepgram"
canonical_url: "https://docs.litellm.ai/docs/providers/deepgram"
type: "docs"
last_updated: "2026-10-01"
summary: "LiteLLM supports Deepgram's /listen endpoint."
related:
  - "/docs/providers/datarobot"
  - "/docs/providers/deepinfra"
---
# Deepgram

> Index of all LiteLLM docs: https://docs.litellm.ai/llms.txt


LiteLLM supports Deepgram's `/listen` endpoint.

| Property | Details |
|-------|-------|
| Description | Deepgram's voice AI platform provides APIs for speech-to-text, text-to-speech, and language understanding. |
| Provider Route on LiteLLM | `deepgram/` |
| Provider Doc | [Deepgram ↗](https://developers.deepgram.com/docs/introduction) |
| Supported OpenAI Endpoints | `/audio/transcriptions` |

## Quick Start

```python
from litellm import transcription
import os 

# set api keys 
os.environ["DEEPGRAM_API_KEY"] = ""
audio_file = open("/path/to/audio.mp3", "rb")

response = transcription(model="deepgram/nova-2", file=audio_file)

print(f"response: {response}")
```

## LiteLLM Proxy Usage

### Add model to config 

1. Add model to config.yaml

```yaml
model_list:
- model_name: nova-2
  litellm_params:
    model: deepgram/nova-2
    api_key: os.environ/DEEPGRAM_API_KEY
  model_info:
    mode: audio_transcription
    
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

### Start proxy 

```bash
litellm --config /path/to/config.yaml 

# RUNNING on http://0.0.0.0:4000
```

### Test 

**Curl**

```bash
curl --location 'http://0.0.0.0:4000/v1/audio/transcriptions' \
--header "Authorization: Bearer $LITELLM_API_KEY" \
--form 'file=@"/Users/krrishdholakia/Downloads/gettysburg.wav"' \
--form 'model="nova-2"'
```

**OpenAI**

```python
from openai import OpenAI
client = openai.OpenAI(
    api_key="sk-<your-litellm-api-key>",
    base_url="http://0.0.0.0:4000"
)

audio_file = open("speech.mp3", "rb")
transcript = client.audio.transcriptions.create(
  model="nova-2",
  file=audio_file
)
```

## Related pages

- [DataRobot](https://docs.litellm.ai/docs/providers/datarobot.md)
- [DeepInfra](https://docs.litellm.ai/docs/providers/deepinfra.md)
