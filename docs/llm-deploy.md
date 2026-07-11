# CapixIDE — LLM Deploy & Endpoints Guide

The Capix network serves OpenAI-compatible LLM endpoints. This doc covers:

1. One-click LLM deploys (featured: SuperGemma × Capix endpoints)
2. All endpoints available on the website
3. How to plug any endpoint into CapixIDE or third-party tools

---

## 1. One-click LLM deploys (`/cloud/llm`)

The LLM Deploy page ([capix.network/cloud/llm](https://capix.network/cloud/llm)) lets you host any model on a rented Vast GPU with a single click. You get back a vLLM-served **OpenAI-compatible endpoint** — `/v1/chat/completions`, `/v1/models`, and `/v1/embeddings` all work.

### The featured models — SuperGemma × Capix

The **SuperGemma × Capix** partner endpoints are the headline of the catalog, shown first with a green badge. They use Google's open Gemma model family:

| Model | Params | Min VRAM | Context | Use case |
|---|---|---|---|---|
| SuperGemma · Gemma 3 27B | 27B | 24GB | 128K | Flagship chat — the star endpoint |
| SuperGemma · Gemma 3 12B | 12B | 16GB | 128K | Sweet spot quality-to-cost |
| SuperGemma · Gemma 3 4B | 4B | 8GB | 128K | Fast + cheap, entry GPU |
| SuperGemma · CodeGemma 7B | 7B | 16GB | 8K | Coding completions + generation |

> **Why SuperGemma is the star:** Capix is the official compute partner of the [Supergemma Foundation](https://supergemma.ai). SGF coordinates open-source funding; Capix hosts the featured endpoints. See `supergemma-partnership.md`.

### The community catalog

Beyond SuperGemma, the catalog includes:

- **Chat:** Qwen2.5 3B/14B/32B, Llama 3.1 8B, Llama 3.2 3B, Mistral 7B, Phi-3.5 Mini, Mixtral 8x7B, Llama 3.3 70B (FP8)
- **Coding:** Qwen2.5-Coder 7B/32B (AWQ), CodeGemma 7B
- **Reasoning:** Qwen2.5 32B (AWQ), DeepSeek-R1 Distill 32B

### How a deploy works

1. Pick a model → the page shows live Vast GPU offers filtered by the model's VRAM requirement.
2. Connect your Solana wallet. Top up at `/cloud/billing`.
3. Pick an offer + duration → click **Deploy model**.
4. Wallet is billed upfront for the duration (refunded automatically on provision failure).
5. A Vast GPU boots with vLLM serving the model on port 8000.
6. Boot + model download: **2–10 min** depending on size.
7. When live, the page shows your **Base URL** (`http://<ip>:<port>/v1`) + **API key** (`cpxllm_…`) + ready-to-paste snippets for every tool.

### Gated models (Gemma, Llama)

Google Gemma and Meta Llama models are gated on Hugging Face. To deploy them:

1. [Create an HF token](https://huggingface.co/settings/tokens) (read access).
2. Accept the model license on its HF page (e.g. [gemma-3-27b-it](https://huggingface.co/google/gemma-3-27b-it)).
3. Paste the token into the "Hugging Face token" field in the deploy form.

The token is passed as `HF_TOKEN` to the VLLM container at boot and is not stored beyond the rental.

---

## 2. All endpoints available on the website

### Self-hosted (one-click deploy) — `/cloud/llm`

You own these for the duration:

| Endpoint | URL | Auth |
|---|---|---|
| Chat completions | `http://<deploy-host>:<port>/v1/chat/completions` | `Authorization: Bearer cpxllm_…` |
| List models | `http://<deploy-host>:<port>/v1/models` | (none — vLLM leaves it open) |
| Embeddings | `http://<deploy-host>:<port>/v1/embeddings` | `Authorization: Bearer cpxllm_…` |

The host + port come from your deploy (`GET /api/llm/[id]?action=status` returns `endpoint`). The API key is the `cpxllm_…` secret shown once at deploy time — save it. The server is fully OpenAI-Chat-Completions-compatible.

### Global inference gateway — `/api/v1/chat/completions`

The always-on gateway routes each request to the cheapest live model across all providers (Surplus Intelligence, OpenRouter, self-hosted vLLM). No deploy needed:

```
POST https://capix.network/api/v1/chat/completions
Authorization: Bearer cpk_…
Content-Type: application/json

{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}
```

The `cpk_` key is created at `/cloud/keys`. Responses include `capix: { route, tokensBilled, usdCost, cpxCost }` metadata. Use `"model": "auto"` for cheapest routing, or specify a model id.

### GPU + instance endpoints — `/api/cloud/*`

- `POST /api/cloud/llm/deploy` — one-click LLM deploy (session auth)
- `GET /api/llm/[id]?action=status` — live endpoint URL + readiness
- `GET /api/llm/[id]?action=list` — your LLM deploys
- `DELETE /api/llm/[id]` — destroy + stop billing
- `GET /api/llm/models` — public model catalog (featured SuperGemma first)
- `GET /api/llm/offers?modelId=…` — live GPU offers that fit a model
- `POST /api/cloud/gpu-deploy` — rent a raw GPU (no model, you install)
- `POST /api/cloud/deploy` — sharded multi-node instance
- `POST /api/v1/chat/completions` — the global gateway (above)

---

## 3. Plug endpoints into CapixIDE

### A self-hosted SuperGemma endpoint

1. Deploy one from `/cloud/llm` (see §1).
2. In CapixIDE, open **Settings → AI**.
3. The **Capix (self-hosted endpoint)** provider is pre-selected on first launch. Fill in:
   - **Base URL:** the URL from the deploy result (ends in `/v1`)
   - **API key:** `cpxllm_…`
   - **Model:** the deployed model label (e.g. "SuperGemma · Gemma 3 27B")
4. Click **Test connection** → should show "ready".
5. Start chatting. The chat panel, inline edit, and autocomplete all route through your endpoint.

### The global Capix gateway

Instead of deploying your own, you can point CapixIDE at the always-on gateway:

- **Base URL:** `https://capix.network/api/v1`
- **API key:** a `cpk_…` key from `/cloud/keys`
- **Model:** `auto` (cheapest routing) or a specific model id

This routes every request across the full provider network — useful for trying many models without deploying anything.

---

## 4. Plug endpoints into third-party tools

The LLM Deploy result page gives you copy-paste snippets for each:

### opencode

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "capix": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Capix LLM (self-hosted)",
      "options": { "baseURL": "http://94.23.x.x:12345/v1", "apiKey": "cpxllm_..." },
      "models": { "SuperGemma · Gemma 3 27B": { "name": "SuperGemma · Gemma 3 27B" } }
    }
  },
  "model": "capix/SuperGemma · Gemma 3 27B"
}
```

### OpenAI Codex

```toml
# ~/.codex/config.toml
model = "SuperGemma · Gemma 3 27B"
model_provider = "capix"

[model_providers.capix]
name = "Capix LLM (self-hosted)"
base_url = "http://94.23.x.x:12345/v1"
env_key = "CAPIX_LLM_KEY"
wire_api = "chat"
```

Then: `export CAPIX_LLM_KEY=cpxllm_... && codex`

### curl

```bash
curl http://94.23.x.x:12345/v1/chat/completions \
  -H "Authorization: Bearer cpxllm_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "SuperGemma · Gemma 3 27B", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### VS Code / Continue.dev

```jsonc
// ~/.continue/config.json
{
  "models": [{
    "title": "SuperGemma", "provider": "openai",
    "model": "SuperGemma · Gemma 3 27B",
    "apiBase": "http://94.23.x.x:12345/v1", "apiKey": "cpxllm_..."
  }]
}
```

### Python (openai SDK)

```python
from openai import OpenAI
client = OpenAI(base_url="http://94.23.x.x:12345/v1", api_key="cpxllm_...")
resp = client.chat.completions.create(
    model="SuperGemma · Gemma 3 27B",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

---

## 5. Manage running deploys

| Action | How |
|---|---|
| List your deploys | `/cloud/instances` (web) or `/api/llm/[id]?action=list` |
| Check readiness | `/api/llm/[id]?action=status` → `ready: true` when vLLM is serving |
| Destroy + stop billing | `DELETE /api/llm/[id]` or the Destroy button on the instance page |

Billing stops the instant the Vast instance is destroyed — you pay only for uptime.
