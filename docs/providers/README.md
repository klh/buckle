# Vendored LiteLLM provider docs (offline reference)

> Vendored 2026-10-02 from [docs.litellm.ai](https://docs.litellm.ai/docs/providers/) — every page under the `providers/` subtree (192 pages), enumerated from the [docs index](https://docs.litellm.ai/llms.txt), fetched as raw markdown via the site's `.md` URL alternates.
> LiteLLM is MIT-licensed; these copies exist so the buckle router plane (litellm-as-engine, W219.1) can answer provider setup questions on an offline LAN.
> Each file = 2-line source header + the page's raw markdown (frontmatter included). Do not hand-edit — re-vendor instead.

- Count: 192 files · total 2.0 MB · pages over 300 KB: 0
- Search: `rg -l 'AZURE_API_KEY' docs/providers/` etc.
- Source index snapshot: https://docs.litellm.ai/llms.txt

## Provider index

| Provider | File | Auth / setup (as documented on the page) |
| --- | --- | --- |
| Abliteration | `abliteration.md` | `ABLITERATION_API_KEY` |
| AI21 | `ai21.md` | `AI21_API_KEY` |
| AI/ML API | `aiml.md` | `AIML_API_KEY`, `AIML_API_BASE` |
| Aleph Alpha | `aleph_alpha.md` | `ALEPHALPHA_API_KEY` |
| Amazon Nova | `amazon_nova.md` | `AMAZON_NOVA_API_KEY` |
| Anthropic | `anthropic.md` | `ANTHROPIC_API_KEY`, `ANTHROPIC_API_BASE`, `LITELLM_ANTHROPIC_DISABLE_URL_SUFFIX` |
| Anthropic Effort Parameter | `anthropic_effort.md` | see `anthropic.md` — `ANTHROPIC_API_KEY` |
| Preserved Thinking Prefix Stability | `anthropic_preserved_thinking.md` | see `anthropic.md` — `ANTHROPIC_API_KEY` |
| Anthropic Programmatic Tool Calling | `anthropic_programmatic_tool_calling.md` | see `anthropic.md` — `ANTHROPIC_API_KEY` |
| Anthropic Tool Input Examples | `anthropic_tool_input_examples.md` | see `anthropic.md` — `ANTHROPIC_API_KEY` |
| Tool Search | `anthropic_tool_search.md` | see `anthropic.md` — `ANTHROPIC_API_KEY` |
| Anyscale | `anyscale.md` | `ANYSCALE_API_KEY` |
| Apertis AI (Stima API) | `apertis.md` | `STIMA_API_KEY` |
| AWS Polly Text to Speech (tts) | `aws_polly.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| AWS Sagemaker | `aws_sagemaker.md` | `CUSTOM_AWS_ACCESS_KEY_ID`, `CUSTOM_AWS_SECRET_ACCESS_KEY`, `CUSTOM_AWS_REGION_NAME` |
| Azure Anthropic (Claude via Azure Foundry) | `azure__azure_anthropic.md` | `AZURE_AI_API_BASE`, `AZURE_AI_API_KEY`, `AZURE_AD_TOKEN` |
| Azure OpenAI Embeddings | `azure__azure_embedding.md` | `AZURE_API_KEY`, `AZURE_API_BASE`, `AZURE_API_VERSION` |
| Azure Responses API | `azure__azure_responses.md` | `AZURE_RESPONSES_OPENAI_API_KEY`, `AZURE_API_KEY`, `AZURE_API_BASE` |
| Azure Text to Speech (tts) | `azure__azure_speech.md` | `AZURE_API_BASE_TTS`, `AZURE_API_KEY_TTS`, `AZURE_API_VERSION` |
| Azure OpenAI | `azure__index.md` | `AZURE_API_KEY`, `AZURE_API_BASE`, `AZURE_API_VERSION` |
| Azure Video Generation | `azure__videos.md` | `AZURE_OPENAI_API_KEY`, `AZURE_API_BASE`, `DATADOG_API_KEY` |
| Azure AI Studio | `azure_ai.md` | `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, `TOGETHERAI_API_KEY` |
| Azure AI Search - Vector Store (Passthrough API) | `azure_ai__azure_ai_vector_stores_passthrough.md` | `AZURE_SEARCH_API_KEY`, `AZURE_API_KEY` |
| Azure Model Router | `azure_ai__azure_model_router.md` | `AZURE_MODEL_ROUTER_API_KEY` |
| Azure AI Foundry Agents | `azure_ai_agents.md` | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| Azure AI Image Generation (Black Forest Labs - Flux) | `azure_ai_img.md` | `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, `LITELLM_MASTER_KEY` |
| Azure AI Image Editing | `azure_ai_img_edit.md` | `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`, `AZURE_AI_API_VERSION` |
| Azure AI Speech (Cognitive Services) | `azure_ai_speech.md` | `AZURE_TTS_API_KEY` |
| Azure AI Search - Vector Store (Unified API) | `azure_ai_vector_stores.md` | `AZURE_SEARCH_API_KEY`, `AZURE_API_KEY`, `AZURE_AI_SEARCH_EMBEDDING_API_BASE` |
| Azure Document Intelligence OCR | `azure_document_intelligence.md` | `AZURE_DOCUMENT_INTELLIGENCE_API_KEY`, `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` |
| Azure AI OCR (Mistral, Cohere Parse) | `azure_ocr.md` | `AZURE_AI_API_KEY`, `AZURE_AI_API_BASE` |
| Baseten | `baseten.md` | `BASETEN_API_KEY` |
| AWS Bedrock | `bedrock.md` | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Bedrock AgentCore | `bedrock_agentcore.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Bedrock Agents | `bedrock_agents.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Bedrock Batches | `bedrock_batches.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_ENCRYPTION_KEY_ID` |
| Bedrock Embedding | `bedrock_embedding.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| AWS Bedrock - Image Generation | `bedrock_image_gen.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| Bedrock Imported Models | `bedrock_imported.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| Amazon Bedrock Mantle | `bedrock_mantle.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BEDROCK_MANTLE_API_KEY` |
| Bedrock Realtime API | `bedrock_realtime_with_audio.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| AWS Bedrock - Rerank API | `bedrock_rerank.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| Bedrock Knowledge Bases | `bedrock_vector_store.md` | `ANTHROPIC_API_KEY` |
| Bedrock - Writer Palmyra | `bedrock_writer.md` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| Black Forest Labs Image Generation | `black_forest_labs.md` | `BFL_API_KEY`, `LITELLM_MASTER_KEY` |
| Black Forest Labs Image Editing | `black_forest_labs_img_edit.md` | `BFL_API_KEY`, `LITELLM_MASTER_KEY` |
| Bytez | `bytez.md` | `BYTEZ_API_KEY` |
| Cerebras | `cerebras.md` | `CEREBRAS_API_KEY` |
| ChatGPT Subscription | `chatgpt.md` | ChatGPT Pro/Max subscription — OAuth device flow |
| Chutes | `chutes.md` | `CHUTES_API_KEY` |
| Clarifai | `clarifai.md` | `CLARIFAI_API_KEY` |
| CLF AI Gateway | `clf_ai_gateway.md` | `CLF_AI_GATEWAY_API_KEY`, `CLF_AI_GATEWAY_API_BASE` |
| Cloudflare Workers AI | `cloudflare_workers.md` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` |
| Codestral API [Mistral AI] | `codestral.md` | `CODESTRAL_API_KEY` |
| Cognition | `cognition.md` | `COGNITION_API_KEY`, `LITELLM_MASTER_KEY`, `COGNITION_API_BASE` |
| Cohere | `cohere.md` | `COHERE_API_KEY`, `TOGETHERAI_API_KEY` |
| CometAPI | `cometapi.md` | `COMETAPI_KEY` |
| CompactifAI | `compactifai.md` | `COMPACTIFAI_API_KEY` |
| Crusoe | `crusoe.md` | `CRUSOE_API_KEY`, `CRUSOE_API_BASE` |
| Custom API Server (Custom Format) | `custom_llm_server.md` | custom in-process handler — bring your own credentials |
| Dashscope API (Qwen models) | `dashscope.md` | `DASHSCOPE_API_KEY`, `DASHSCOPE_API_BASE` |
| Databricks | `databricks.md` | `DATABRICKS_API_KEY`, `DATABRICKS_API_BASE`, `DATABRICKS_CLIENT_ID` |
| DataRobot | `datarobot.md` | `DATAROBOT_API_TOKEN`, `DATAROBOT_ENDPOINT` |
| Deepgram | `deepgram.md` | `DEEPGRAM_API_KEY`, `LITELLM_MASTER_KEY` |
| DeepInfra | `deepinfra.md` | `DEEPINFRA_API_KEY` |
| Deepseek | `deepseek.md` | `DEEPSEEK_API_KEY` |
| Docker Model Runner | `docker_model_runner.md` | `DOCKER_MODEL_RUNNER_API_BASE`, `DOCKER_MODEL_RUNNER_API_KEY` |
| Eden AI | `edenai.md` | `EDENAI_API_KEY`, `EDENAI_API_BASE` |
| ElevenLabs | `elevenlabs.md` | `ELEVENLABS_API_KEY`, `LITELLM_MASTER_KEY` |
| EmpirioLabs AI | `empiriolabs.md` | `EMPIRIOLABS_API_KEY` |
| Empower | `empower.md` | `EMPOWER_API_KEY`, `TOGETHERAI_API_KEY` |
| Fal AI | `fal_ai.md` | `FAL_AI_API_KEY`, `LITELLM_MASTER_KEY` |
| Featherless AI | `featherless_ai.md` | `FEATHERLESS_AI_API_KEY` |
| Fireworks AI | `fireworks_ai.md` | `FIREWORKS_AI_API_KEY`, `ANTHROPIC_API_KEY`, `FIREWORKS_AI_API_BASE` |
| FriendliAI | `friendliai.md` | `FRIENDLI_TOKEN` |
| Galadriel | `galadriel.md` | `GALADRIEL_API_KEY` |
| Gemini - Google AI Studio | `gemini.md` | `GEMINI_API_KEY` |
| Gemini Lyria (music generation) | `gemini__music.md` | see `gemini.md` — `GEMINI_API_KEY` |
| Gemini Video Generation (Veo) | `gemini__videos.md` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| Gemini File Search | `gemini_file_search.md` | see `gemini.md` — `GEMINI_API_KEY` |
| GigaChat | `gigachat.md` | `GIGACHAT_CREDENTIALS`, `GIGACHAT_SCOPE` |
| Github | `github.md` | `GITHUB_API_KEY` |
| GitHub Copilot | `github_copilot.md` | OAuth device flow; token cache via `GITHUB_COPILOT_TOKEN_DIR` / `GITHUB_COPILOT_ACCESS_TOKEN_FILE` / `GITHUB_COPILOT_API_KEY_FILE` |
| GMI Cloud | `gmi.md` | `GMI_API_KEY` |
| [BETA] Google AI Studio (Gemini) Files API | `google_ai_studio__files.md` | `GEMINI_API_KEY`, `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_FILE_SYSTEM` |
| Google AI Studio Image Generation | `google_ai_studio__image_gen.md` | `GEMINI_API_KEY`, `LITELLM_MASTER_KEY` |
| Gemini Realtime API - Google AI Studio | `google_ai_studio__realtime.md` | `GEMINI_API_KEY` |
| GradientAI | `gradient_ai.md` | `GRADIENT_AI_API_KEY`, `GRADIENT_AI_AGENT_ENDPOINT` |
| Groq | `groq.md` | `GROQ_API_KEY` |
| Helicone | `helicone.md` | `HELICONE_API_KEY` |
| Heroku | `heroku.md` | `HEROKU_API_BASE`, `HEROKU_API_KEY` |
| Hugging Face | `huggingface.md` | `HF_TOKEN` |
| HuggingFace Rerank | `huggingface_rerank.md` | `HF_TOKEN`, `HUGGINGFACE_API_KEY` |
| Hyperbolic | `hyperbolic.md` | `HYPERBOLIC_API_KEY` |
| Inception | `inception.md` | `INCEPTION_API_KEY` |
| Infinity | `infinity.md` | `INFINITY_API_KEY`, `INFINITY_API_BASE` |
| Jina AI | `jina_ai.md` | `JINA_AI_API_KEY` |
| Lambda AI | `lambda_ai.md` | `LAMBDA_API_KEY`, `LAMBDA_API_BASE` |
| LangGraph | `langgraph.md` | LangGraph server URL (e.g. `http://localhost:2024`) |
| Lemonade | `lemonade.md` | `LEMONADE_API_BASE` |
| LiteLLM Proxy (LLM Gateway) | `litellm_proxy.md` | `LITELLM_PROXY_API_KEY`, `LITELLM_PROXY_API_BASE`, `USE_LITELLM_PROXY` |
| Llamafile | `llamafile.md` | `LLAMAFILE_API_BASE` |
| LlamaGate | `llamagate.md` | `LLAMAGATE_API_KEY` |
| LM Studio | `lm_studio.md` | `LM_STUDIO_API_BASE`, `LM_STUDIO_API_KEY` |
| Manus | `manus.md` | `MANUS_API_KEY` |
| Meta Model API | `meta.md` | `META_API_KEY` |
| Meta Llama | `meta_llama.md` | `LLAMA_API_KEY` |
| Milvus - Vector Store | `milvus_vector_stores.md` | `MILVUS_API_KEY`, `AZURE_API_KEY`, `MILVUS_API_BASE` |
| MiniMax | `minimax.md` | `MINIMAX_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` |
| Mistral AI API | `mistral.md` | `MISTRAL_API_KEY` |
| Mistral AI Batch API | `mistral_batches.md` | `MISTRAL_API_KEY` |
| MongoDB - Vector Store (BETA) | `mongodb_vector_stores.md` | `MONGODB_SIDECAR_API_KEY`, `LITELLM_API_KEY` |
| Moonshot AI | `moonshot.md` | `MOONSHOT_API_KEY`, `MOONSHOT_API_BASE` |
| Morph | `morph.md` | `MORPH_API_KEY` |
| Nadir | `nadir.md` | `NADIR_API_KEY`, `NADIR_API_BASE` |
| NanoGPT | `nano-gpt.md` | `NANOGPT_API_KEY` |
| Nebius AI Studio | `nebius.md` | `NEBIUS_API_KEY` |
| NLP Cloud | `nlp_cloud.md` | `NLP_CLOUD_API_KEY` |
| Novita AI | `novita.md` | `NOVITA_API_KEY` |
| Nscale (EU Sovereign) | `nscale.md` | `NSCALE_API_KEY` |
| Nvidia NIM | `nvidia_nim.md` | `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_API_BASE` |
| Nvidia NIM - Rerank | `nvidia_nim_rerank.md` | `NVIDIA_NIM_API_KEY`, `NVIDIA_NIM_API_BASE` |
| Nvidia Riva (Speech-to-Text) | `nvidia_riva.md` | `NVIDIA_RIVA_API_KEY`, `LITELLM_MASTER_KEY` |
| Oracle Cloud Infrastructure (OCI) | `oci.md` | `OCI_REGION`, `OCI_USER`, `OCI_FINGERPRINT` |
| Ollama | `ollama.md` | local server `http://localhost:11434` — no key required |
| OpenAI | `openai.md` | `OPENAI_API_KEY`, `LITELLM_MASTER_KEY`, `OPENAI_ORGANIZATION` |
| OpenAI - Response API | `openai__responses_api.md` | `OPENAI_API_KEY` |
| OpenAI - Text-to-speech | `openai__text_to_speech.md` | `OPENAI_API_KEY` |
| OpenAI Video Generation | `openai__videos.md` | `OPENAI_API_KEY` |
| OpenAI-Compatible Endpoints | `openai_compatible.md` | any OpenAI-format endpoint: `api_base` + `api_key` |
| OpenRouter | `openrouter.md` | `OPENROUTER_API_KEY`, `OPENROUTER_API_BASE`, `OR_SITE_URL` |
| OVHCloud AI Endpoints | `ovhcloud.md` | `OVHCLOUD_API_KEY` |
| Perplexity AI (pplx-api) | `perplexity.md` | `PERPLEXITYAI_API_KEY`, `PERPLEXITY_API_KEY` |
| Perplexity Embeddings | `perplexity_embedding.md` | `PERPLEXITYAI_API_KEY` |
| Petals | `petals.md` | no key documented on the page |
| Poe | `poe.md` | `POE_API_KEY` |
| Predibase | `predibase.md` | `PREDIBASE_API_KEY`, `PREDIBASE_TENANT_ID` |
| Prism | `prism.md` | `PRISM_API_KEY`, `PRISM_API_BASE` |
| PublicAI | `publicai.md` | `PUBLICAI_API_KEY`, `PUBLICAI_API_BASE` |
| Pydantic AI Agents | `pydantic_ai_agent.md` | agent server URL (e.g. `http://localhost:9999`) |
| QwenCloud and Qianwen AI Platform (Qwen models) | `qwencloud.md` | `QWENCLOUD_API_KEY`, `QWEN_AI_PLATFORM_API_KEY` |
| RAGFlow | `ragflow.md` | `RAGFLOW_API_KEY`, `RAGFLOW_API_BASE` |
| RAGFlow Vector Stores | `ragflow_vector_store.md` | `OPENAI_API_KEY`, `RAGFLOW_API_KEY`, `RAGFLOW_API_BASE` |
| Recraft | `recraft.md` | `RECRAFT_API_KEY`, `LITELLM_MASTER_KEY`, `RECRAFT_API_BASE` |
| Replicate | `replicate.md` | `REPLICATE_API_KEY` |
| RunwayML - Image Generation | `runwayml__images.md` | `RUNWAYML_API_KEY` |
| RunwayML - Text-to-Speech | `runwayml__text-to-speech.md` | `RUNWAYML_API_KEY` |
| RunwayML - Video Generation | `runwayml__videos.md` | `RUNWAYML_API_KEY` |
| AWS S3 Vectors | `s3_vectors.md` | `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| SambaNova | `sambanova.md` | `SAMBANOVA_API_KEY` |
| SAP Generative AI Hub | `sap.md` | `LITELLM_LOG`, `LITELLM_PROXY_API_KEY`, `AICORE_SERVICE_KEY` |
| Sarvam.ai | `sarvam.md` | `SARVAM_API_KEY` |
| Scaleway | `scaleway.md` | `SCW_SECRET_KEY` |
| SCX.ai | `scx_ai.md` | `SCX_API_KEY`, `SCX_API_BASE` |
| Snowflake Cortex | `snowflake.md` | `SNOWFLAKE_JWT`, `SNOWFLAKE_ACCOUNT_ID` |
| Stability AI | `stability.md` | `STABILITY_API_KEY`, `LITELLM_MASTER_KEY`, `AWS_ACCESS_KEY_ID` |
| Synthetic | `synthetic.md` | `SYNTHETIC_API_KEY` |
| Tencent TokenHub | `tencent.md` | `TENCENT_API_KEY`, `TENCENT_API_BASE`, `TENCENT_ANTHROPIC_API_BASE` |
| Tensormesh | `tensormesh.md` | `TENSORMESH_INFERENCE_API_KEY`, `LITELLM_MASTER_KEY` |
| OpenAI (Text Completion) | `text_completion_openai.md` | `OPENAI_API_KEY` |
| Together AI | `togetherai.md` | `TOGETHERAI_API_KEY` |
| Topaz | `topaz.md` | `TOPAZ_API_KEY` |
| Triton Inference Server | `triton-inference-server.md` | Triton server URL (`api_base`) |
| v0 | `v0.md` | `V0_API_KEY` |
| Valkey - Vector Store | `valkey_vector_stores.md` | `OPENAI_API_KEY`, `VALKEY_PASSWORD` |
| Vercel AI Gateway | `vercel_ai_gateway.md` | `VERCEL_AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, `VERCEL_SITE_URL` |
| VertexAI [Gemini] | `vertex.md` | GCP credentials + project (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| Vertex AI Video Generation (Veo) | `vertex_ai__videos.md` | GCP credentials + project (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| Vertex AI Agent Engine | `vertex_ai_agent_engine.md` | `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEXAI_PROJECT`, `VERTEXAI_LOCATION` |
| Vertex Batch APIs | `vertex_batch.md` | GCP credentials + project (batch needs a GCS bucket service account) |
| Vertex AI Embedding | `vertex_embedding.md` | GCP credentials + project (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| Vertex AI Image Generation | `vertex_image.md` | GCP credentials + project (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| Vertex AI OCR | `vertex_ocr.md` | GCP credentials + project (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| Vertex AI - Anthropic, DeepSeek, Model Garden, xAI | `vertex_partner.md` | `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEXAI_PROJECT`, `VERTEXAI_LOCATION` |
| Vertex AI Gemini Live - Realtime API | `vertex_realtime.md` | `GOOGLE_APPLICATION_CREDENTIALS` |
| Vertex AI - Self Deployed Models | `vertex_self_deployed.md` | `VERTEXAI_PROJECT`, `VERTEXAI_LOCATION` |
| Vertex AI Text to Speech | `vertex_speech.md` | GCP credentials + project (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| Vertex AI Audio Transcription | `vertex_transcription.md` | GCP credentials + project (`VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`) |
| VLLM | `vllm.md` | self-hosted server; optional `HOSTED_VLLM_API_KEY` |
| vLLM - Batch + Files API | `vllm_batches.md` | `HOSTED_VLLM_API_KEY`, `DATABASE_URL` |
| Volcano Engine (Volcengine) | `volcano.md` | `VOLCENGINE_API_KEY`, `ARK_API_KEY` |
| Voyage AI | `voyage.md` | `VOYAGE_API_KEY` |
| Weights & Biases Inference | `wandb_inference.md` | `WANDB_API_KEY` |
| WatsonX Audio Transcription | `watsonx__audio_transcription.md` | `WATSONX_APIKEY`, `WATSONX_URL`, `WATSONX_PROJECT_ID` |
| IBM watsonx.ai | `watsonx__index.md` | `WATSONX_API_KEY`, `WATSONX_URL`, `WATSONX_APIKEY` |
| watsonx.ai Rerank | `watsonx__rerank.md` | `WATSONX_APIKEY`, `WATSONX_API_BASE`, `WATSONX_PROJECT_ID` |
| xAI | `xai.md` | `XAI_API_KEY` |
| xAI Batch API | `xai_batches.md` | `XAI_API_KEY` |
| xAI Voice Agent (Realtime API) | `xai_realtime.md` | `XAI_API_KEY`, `OPENAI_API_KEY` |
| Xiaomi MiMo | `xiaomi_mimo.md` | `XIAOMI_MIMO_API_KEY` |
| Xinference [Xorbits Inference] | `xinference.md` | `LITELLM_MASTER_KEY`, `XINFERENCE_API_BASE`, `XINFERENCE_API_KEY` |
| Z.AI (Zhipu AI) | `zai.md` | `ZAI_API_KEY` |
