# CapixIDE — Full Guide

CapixIDE is the open-source AI IDE for the Capix protocol: a VS Code-compatible editor with a built-in AI chat panel, one-click import from VS Code or JetBrains, and native one-click LLM deploys to the Capix GPU network. It's the easiest way to go from "I want an AI coding assistant" to "I have my own private OpenAI endpoint" in under 10 minutes.

## 1. Download & Install

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | `CapixIDE-vX.Y.Z-darwin-arm64-unsigned.tar.gz` |
| macOS (Intel) | `CapixIDE-vX.Y.Z-darwin-x64-unsigned.tar.gz` |
| Windows x64 | `CapixIDE-vX.Y.Z-win32-x64-unsigned.zip` |
| Linux x64 | `CapixIDE-vX.Y.Z-linux-x64-unsigned.tar.gz` |

Get the latest from [the official CapixIDE releases](https://github.com/CapIX-Protocol/CapIX-IDE/releases) or [capix.network/ide](https://capix.network/ide). Every archive is unsigned and must be verified with its adjacent `.sha256` file before extraction; see [`../INSTALL.md`](../INSTALL.md).

- **Mac:** Extract the verified `.tar.gz`, copy `CapixIDE.app` to Applications, then right-click → **Open** on first launch.
- **Windows:** Extract the verified `.zip` and run `CapixIDE.exe`; SmartScreen may require **More info → Run anyway**.
- **Linux:** Extract the verified `.tar.gz` into a user-local directory and run the included executable.

## 2. Import your existing settings

On first launch, CapixIDE shows the Import Wizard:

```
┌ Import from ─────────────────────────┐
│   ○ VS Code                          │
│   ○ Cursor                           │
│   ○ Windsurf                          │
│   ○ JetBrains (IntelliJ/PyCharm/etc) │
│   ○ Start fresh                       │
└──────────────────────────────────────┘
```

- **VS Code / Cursor / Windsurf** — copies your `settings.json`, `keybindings.json`, and `extensions/` folder (filtering out conflicting AI extensions). Your shortcuts and themes stay identical.
- **JetBrains** — runs `scripts/jetbrains-importer.mjs`, translating your IntelliJ/PyCharm/WebStorm keymap XML and color scheme `.icls` into VS Code `keybindings.json` + a theme JSON.

Re-run any time from the Command Palette: `> CapixIDE: Import settings from another editor`.

## 3. Configure your AI provider

Open **Settings → AI** (or the gear icon in the chat sidebar). The **Capix (self-hosted endpoint)** provider is pre-selected on a fresh install — you just need to fill in two fields:

```
┌ AI Provider ─────────────────────────────────────┐
│  Provider:  [Capix (self-hosted endpoint) ▼]    │
│                                                  │
│  Base URL:  [http://94.23.x.x:12345/v1]          │
│  ↓ from capix.network → Cloud → LLM Deploy       │
│                                                  │
│  API key:   [cpxllm_************************]    │
│  ↓ shown once when your deploy goes live         │
│                                                  │
│  Model:     [SuperGemma · Gemma 3 27B  ▼]        │
│  ↓ the label of the model you deployed           │
│                                                  │
│  [ Test connection ]                              │
└──────────────────────────────────────────────────┘
```

### Option A — deploy a SuperGemma endpoint first (recommended)

The **SuperGemma × Capix** partner endpoints are the headline of the catalog — best quality-to-cost ratios. Deploying one takes ~5 min:

1. Go to **[capix.network/cloud/llm](https://capix.network/cloud/llm)**.
2. Pick a SuperGemma model from the green featured section (e.g. **Gemma 3 27B** — the flagship).
3. Paste a Hugging Face token (they're gated — [get one here](https://huggingface.co/settings/tokens)).
4. Pick a GPU offer (pre-filtered to ones that fit) + duration.
5. Click **Deploy model**.
6. When the endpoint is live, copy the **Base URL** + **API key** into CapixIDE Settings → AI.
7. Click **Test connection** → start chatting.

See `docs/llm-deploy.md` for the full deploy walkthrough.

### Option B — any hosted provider

CapixIDE signs in to the Capix smart router and selects the available `Auto` route. Customers do not configure upstream services or paste third-party credentials into the IDE.

## 4. Code with AI

| Feature | Shortcut | What it does |
|---|---|---|
| Chat sidebar | `Cmd/Ctrl+Shift+L` | Ask questions, generate code, review diffs |
| Inline edit | `Cmd/Ctrl+I` | Edit the current file with AI inline |
| Autocomplete | (automatic) | FIM completions as you type (configure the model in Settings) |
| Agent mode | (in chat panel) | Let the AI run commands and edit files across your project; approve each action |
| Quick command | `Cmd/Ctrl+K` | Open the quick-edit popup |

## 5. One-click LLM deploys from inside the IDE

The Command Palette exposes deploy actions that hit the Capix API directly:

```
> CapixIDE: Deploy LLM…
  → SuperGemma · Gemma 3 27B
  → SuperGemma · Gemma 3 12B
  → SuperGemma · Gemma 3 4B
  → SuperGemma · CodeGemma 7B
  → (community models…)
```

Selecting one opens the deploy flow (model + GPU offer + duration), provisions the Vast instance, and — when ready — auto-fills your Settings → AI Base URL + key + model. You're chatting in under 10 minutes with zero copy-paste.

## 6. Extension marketplace

CapixIDE uses [Open VSX](https://open-vsx.org) (license-compatible), so the standard VS Code extension flow works:

- `Cmd/Ctrl+Shift+X` opens Extensions.
- Search and install. Python, ESLint, Prettier, GitLens, Docker, etc. all work.
- Some Microsoft-published extensions are marketplace-restricted (e.g. GitHub Copilot, Pylance) — they won't appear, since we use Open VSX not Microsoft's gallery. That's by design (it's the license-clean path, same as VSCodium).

## 7. Building from source

```bash
mkdir capix-build && cd capix-build
git clone https://github.com/CapIX-Protocol/CapIX-Code.git capix-code
git -C capix-code checkout 80b48d576deea2ec36a44c505a6e7c6e3b87d088
# Build capix-code/dist/customer using the Capix Code build guide first.

git clone https://github.com/CapIX-Protocol/CapIX-IDE.git
cd CapIX-IDE
./scripts/bootstrap.sh
CAPIX_CODE_CUSTOMER_DIR=../capix-code/dist/customer ./scripts/dev.sh
```

See `docs/contributing.md` for prereqs (Node 20.18.2, platform native deps) and the build pipeline.

## 8. Where to find everything

| What | Where |
|---|---|
| Download archives | [capix.network/ide](https://capix.network/ide) · [GitHub Releases](https://github.com/CapIX-Protocol/CapIX-IDE/releases) |
| Source code | [github.com/CapIX-Protocol/CapIX-IDE](https://github.com/CapIX-Protocol/CapIX-IDE) |
| LLM deploy (web) | [capix.network/cloud/llm](https://capix.network/cloud/llm) |
| SuperGemma partnership doc | [docs/supergemma-partnership.md](supergemma-partnership.md) |
| LLM deploy guide | [docs/llm-deploy.md](llm-deploy.md) |
| API reference | `/api/llm/models`, `/api/llm/offers`, `/api/llm/deploy`, `/api/llm/[id]` |
| Report an issue | [github.com/CapIX-Protocol/CapIX-IDE/issues](https://github.com/CapIX-Protocol/CapIX-IDE/issues) |

## License

CapixIDE is open source under Apache-2.0 (the CapixIDE rebrand kit + JetBrains importer) on top of Void (Apache-2.0, Glass Devtools) and VS Code (MIT, Microsoft). See `LICENSE`, `NOTICE`, and `ThirdPartyNotices.txt`.
