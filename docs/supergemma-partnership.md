# SuperGemma × Capix — Partnership

Capix is the official compute partner of the [Supergemma Foundation (SGF)](https://supergemma.ai). This doc lives in both the Capix-Protocol repo (`docs/SUPERGEMMA_PARTNERSHIP.md`) and here (CapixIDE) for IDE users.

> **Note:** Supergemma Foundation is an independent, community-driven project. It is not affiliated with Google LLC, Google DeepMind, or the Gemma model family. "SuperGemma" branding on Capix refers to the SGF partnership and its featured endpoints, which run Google's open Gemma model weights.

## The partnership

| Layer | SGF | Capix |
|---|---|---|
| Funding + ecosystem coordination | $SUPERGEMMA token, launchpad, grants | — |
| Compute infrastructure | — | Vast.ai GPU rentals + vLLM endpoints |
| AI IDE | — | CapixIDE |
| Featured endpoints | Discovery + community | Hosting + OpenAI API |

## The featured endpoints

The **SuperGemma × Capix** endpoints are the headline of the Capix LLM catalog — shown first with a green badge at [capix.network/cloud/llm](https://capix.network/cloud/llm):

| Model | Params | Min VRAM | Best for |
|---|---|---|---|
| **SuperGemma · Gemma 3 27B** | 27B | 24GB | Flagship chat — the headline endpoint |
| **SuperGemma · Gemma 3 12B** | 12B | 16GB | Best quality-to-cost |
| **SuperGemma · Gemma 3 4B** | 4B | 8GB | Fast + cheap |
| **SuperGemma · CodeGemma 7B** | 7B | 16GB | Coding |

## Deploy → use in CapixIDE

1. Deploy a SuperGemma endpoint at [capix.network/cloud/llm](https://capix.network/cloud/llm) (3–8 min).
2. In CapixIDE → Settings → AI, the **Capix (self-hosted endpoint)** provider is pre-selected.
3. Paste the Base URL + API key from the deploy result.
4. Set the Model to the deployed label (e.g. "SuperGemma · Gemma 3 27B").
5. Test connection → start chatting.

See `llm-deploy.md` for snippets for opencode, Codex, curl, VS Code, and Python.

## $SUPERGEMMA token

- **Contract (Base):** `0x572c4fa77623652411574c51b5ddb7e1b750aba3`
- **Chain:** Base
- **Role:** ecosystem coordination (grants, treasury, developer onboarding)
- **Verify:** [BaseScan](https://basescan.org/token/0x572c4fa77623652411574c51b5ddb7e1b750aba3) · [DexScreener](https://dexscreener.com/base/0x572c4fa77623652411574c51b5ddb7e1b750aba3)

$SUPERGEMMA is not required to deploy or use Capix endpoints — billing is in SOL/USDC/CPX from your wallet balance.

## Links

- **Supergemma Foundation** — [supergemma.ai](https://supergemma.ai) · [@0xsupergemma](https://x.com/0xsupergemma)
- **Capix Protocol** — [capix.network](https://capix.network)
- **CapixIDE** — [capix.network/ide](https://capix.network/ide)
