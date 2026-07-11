# CapixIDE — Getting Started

## 1. Install

Download the installer for your OS from the [Releases page](https://github.com/Ritzky/CapixIDE/releases):

| Platform | File |
|---|---|
| macOS (M-series) | `CapixIDE-x.x.x-arm64.dmg` |
| macOS (Intel) | `CapixIDE-x.x.x-x64.dmg` |
| Windows | `CapixIDE-Setup-x.x.x.exe` |
| Linux | `CapixIDE-x.x.x.AppImage` (or `.deb` / `.rpm`) |

- **Mac:** Open the `.dmg`, drag CapixIDE to Applications. Notarized builds open without Gatekeeper warnings. For self-built/pre-notarization builds, right-click → Open on first launch.
- **Windows:** Run the `.exe`. The NSIS installer lets you pick the install directory.
- **Linux:** Make the AppImage executable (`chmod +x CapixIDE-*.AppImage`) and run, or install the `.deb` / `.rpm`.

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

- **VS Code / Cursor / Windsurf** — copies your `settings.json`, `keybindings.json`, and the entire `extensions/` folder (filtering out known-incompatible AI extensions so they don't conflict with CapixIDE's chat).
- **JetBrains** — runs `scripts/jetbrains-importer.mjs`, which translates your IntelliJ/PyCharm/WebStorm keymap XML and color scheme `.icls` into VS Code `keybindings.json` and a theme JSON. Some shortcuts may need manual tuning (VS Code and JetBrains keymaps are not 1:1).

You can re-run the importer any time from the Command Palette:

```
> CapixIDE: Import settings from another editor
```

## 3. Configure your AI provider

Open **Settings → AI** (or the gear icon in the chat sidebar):

```
┌ AI Provider ─────────────────────────────────┐
│  Provider:  [Capix (self-hosted)      ▼]     │
│  Base URL:  [http://12.3.4.5:12345/v1]        │
│  API key:   [cpxllm_************************] │
│  Model:     [Qwen2.5-Coder 7B        ▼]       │
│  ───────────────────────────────────────────  │
│  Or pick a hosted provider:                   │
│  Anthropic · OpenAI · DeepSeek · Ollama · …   │
└──────────────────────────────────────────────┘
```

### Option A — use a Capix-deployed LLM

1. Go to [capix.network](https://capix.network) → **Cloud → LLM Deploy**.
2. Pick a model (e.g. Qwen2.5-Coder 7B), pick a GPU, click Deploy.
3. Wait 2–10 min for the endpoint to go live.
4. Copy the **Base URL** and **API key** shown on the deploy result into CapixIDE Settings → AI.

See [`llm-deploy.md`](llm-deploy.md) for the full deploy walkthrough.

### Option B — use any hosted provider

CapixIDE inherits Void's provider list: Anthropic, OpenAI, DeepSeek, OpenRouter, Ollama, vLLM, LM Studio, Groq, xAI, Mistral, Gemini, etc. Paste your API key for whichever one you use.

## 4. Start coding with AI

- **Chat sidebar** — `Cmd/Ctrl+Shift+L` to toggle. Ask questions, generate code, review diffs.
- **Inline edit** — `Cmd/Ctrl+I` in any file to edit with AI inline.
- **Autocomplete** — starts automatically as you type (configure the model in Settings).
- **Agent mode** — let the AI run commands and edit files across your project (approve each action in the panel).

## Keyboard shortcuts

If you imported from VS Code / Cursor / Windsurf, your shortcuts stay the same. If you imported from JetBrains, common translated shortcuts include:

| Action | JetBrains | CapixIDE (VS Code) |
|---|---|---|
| Go to file | `Ctrl+Shift+N` | `Ctrl+Shift+N` |
| Search everywhere | `Shift+Shift` | `Ctrl+P` |
| Find in project | `Ctrl+Shift+F` | `Ctrl+Shift+F` |
| Comment line | `Ctrl+/` | `Ctrl+/` |
| Reformat | `Ctrl+Alt+L` | `Shift+Alt+F` |
| Rename | `Shift+F6` | `F2` |
| Quick fix | `Alt+Enter` | `Ctrl+.` |

Tune any shortcut in **Settings → Keyboard Shortcuts** (`Cmd/Ctrl+K Cmd/Ctrl+S`).
