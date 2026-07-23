# CapixIDE — Getting Started

## 1. Install

Download the unsigned portable archive for your OS from the [official Releases page](https://github.com/CapIX-Protocol/CapIX-IDE/releases). Verify its adjacent `.sha256` file before extraction:

| Platform | File |
|---|---|
| macOS (M-series) | `CapixIDE-vX.Y.Z-darwin-arm64-unsigned.tar.gz` |
| macOS (Intel) | `CapixIDE-vX.Y.Z-darwin-x64-unsigned.tar.gz` |
| Windows x64 | `CapixIDE-vX.Y.Z-win32-x64-unsigned.zip` |
| Linux x64 | `CapixIDE-vX.Y.Z-linux-x64-unsigned.tar.gz` |

- **Mac:** Verify and extract the `.tar.gz`, copy `CapixIDE.app` to Applications, then control-click → **Open** on first launch.
- **Windows:** Verify and extract the `.zip`, then run `CapixIDE.exe`. SmartScreen may require **More info → Run anyway** because the build is unsigned.
- **Linux:** Verify and extract the `.tar.gz` into a user-local directory, then run the included `capix` or `capixide` executable.

Use [`../INSTALL.md`](../INSTALL.md) for exact copy-paste checksum and installation commands.

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

CapixIDE signs in to the Capix smart router and selects the available `Auto` route. No third-party model credential is required in the IDE.

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
