# Capix IDE

The AI IDE for the Capix protocol, with routed inference, LLM deploys, cloud panels, a native SSH terminal, Covenant memory, and seamless profile sync between the web console and CapixIDE.

CapixIDE builds are **unsigned**. On macOS, right-click the app → **Open** on first launch (Gatekeeper will warn that the app is unverified).

## Install

One command — the installer resolves the latest release, verifies the published SHA-256 checksum, installs, and launches:

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/CapIX-Protocol/CapIX-IDE/main/scripts/ide-install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/CapIX-Protocol/CapIX-IDE/main/scripts/ide-install.ps1 | iex
```

On first run the Capix Code chat docks on the right and inline completion is on — everything works out of the box.

## Download

Pre-built unsigned archives for macOS, Windows, and Linux are on the [official Releases page](https://github.com/CapIX-Protocol/CapIX-IDE/releases).

See **[INSTALL.md](INSTALL.md)** for exact checksum, installation, authentication,
update, and uninstall commands for macOS arm64/x64, Linux x64, and Windows x64.

## What's in the box?

CapixIDE is a full project editor with an integrated Capix command centre that includes:

### LLM Deploy + Management
- **Model Catalog** — browse featured partner + community models; click to deploy on a GPU
- **Deploy custom models** — paste a Hugging Face link; we auto-detect the GPU specs (VRAM, params, context)
- **My Deploys** — live status of your running/stopped/provisioning deploys
- **Destroy / Stop / Start** — full GPU instance lifecycle with confirmation dialogs
- **View logs** — fetch vLLM boot + server logs to see why a deploy hasn't gone live
- **Run command on GPU** — execute `nvidia-smi`, `docker ps`, `docker logs` on the instance for debugging (command allowlist enforced)
- **Copy endpoint / API key** — one click to copy the OpenAI base URL + Bearer key
- **Region selection** — deploy to Europe, North America, Asia-Pacific, or Global

### Cloud Panels (all synced with the web console)
- **Instances** — list VPS / GPU / LLM deploys with start/stop/destroy/SSH controls
- **Agents** — list GitHub repo deploys with view logs / open terminal
- **Serverless Jobs** — list + trigger capix-job.yml jobs
- **API Keys** — create / revoke `cpk_` keys for the OpenAI-compatible chat gateway

### Profile (synced across web + IDE)
- **Wallet balance** — USD + SOL + USDC equivalents, with active billing per-deploy ($/hr + $/min)
- **Top up** — SOL, USDC (Solana), or USDC on Base (EVM tx-hash verify)
- **Total spent** — lifetime billing history

### Native SSH Terminal
- Click "Open Terminal" on any instance or deployment → opens an integrated terminal pre-configured with SSH
- Reuses existing terminals for the same host
- Run commands directly on your deployed GPU instances

### Auto-Connect LLM
- When an LLM deploy becomes ready (in the IDE or on capix.network), the chat provider is auto-configured with the base URL + API key
- Checks for existing ready deploys on startup — if any exist, auto-configures from the most recent one
- Credentials are stored in the operating system credential store, never in plaintext

### Profile Sync
- Same session token = shared balance, deploys, instances across the web console and the IDE
- Deploy on the web → shows up in the IDE instantly. Deploy in the IDE → visible on the web.
- Connect once with your `cpx_session.…` token — everything syncs.

### Dev Tokens (proof-of-development)
- Capix IDE automatically mints **DEV tokens** to your wallet when verifiable development happens:
  - Commit code with Capix Code → 1 DEV
  - Deploy an app/agent/LLM → 5 DEV
  - Complete a productive session (50+ turns) → 10 DEV
  - Record an architectural decision in Covenant → 2 DEV
  - Ship a complete product → 50 DEV
- Tokens are on-chain proof of useful work (Solana devnet pre-mainnet)
- In the future, DEV tokens will be exchangeable for SOL or CPX
- Visible in the Profile panel alongside your wallet balance

### Covenant (memory + governance + spirit)
- **Spirit** — a system prompt with behavioral guidelines + hard governance rules (no destructive actions without approval, always explain changes, match existing style)
- **Memory** — persistent store of decisions/patterns/feedback/context, injected into the system prompt before every chat call
- **Governance** — enforced client-side: never delete files without asking, never commit without approval, warn before breaking changes
- Editable `.capix/covenant.md` file for custom personality/rules
- Commands: Edit Covenant, Remember, Clear Memory

### Capix Code (CLI assistant) Integration
- "Capix: Launch Capix Code" command opens a terminal with `capix-code` pre-configured (env vars from SecretStorage)
- Falls back to the Capix gateway if no deployed LLM is configured
- `capix-code` is the Capix CLI coding assistant — [github.com/CapIX-Protocol/capix-code](https://github.com/CapIX-Protocol/capix-code)

### Settings Import
- **Compatible editors** — imports supported settings, keybindings, themes, and extensions on first launch
- **Compatible IDEs** — translates supported keymaps and colour schemes into CapixIDE format

### Other
- **Capix logo + branding** — the activity bar icon is the real Capix brand mark, the status bar shows connection state, the sidebar is titled "Capix"
- **Extension marketplace** — uses [Open VSX](https://open-vsx.org) (license-clean)
- **Cross-platform** — portable, checksummed `.tar.gz` builds for macOS/Linux and `.zip` builds for Windows via GitHub Actions
- **Security** — session tokens and API keys remain in the operating system credential store, with webview CSP, per-render nonces, an SSH command allowlist, and pinned host-key verification

## Quick start (users)

1. Follow the commands in [INSTALL.md](INSTALL.md) and verify the downloaded SHA-256 checksum.
2. On first launch, CapixIDE offers to import compatible themes, keybindings, settings, and extensions.
3. Select **Sign In** in the Capix Profile and complete the browser wallet-signature flow. Never paste session or refresh tokens.
4. Your profile, deploys, and instances sync automatically.
5. Deploy an LLM from the Model Catalog → when ready, the chat panel auto-configures.
6. Or launch `capix-code` in the terminal via **Capix: Launch Capix Code**.

See [`docs/getting-started.md`](docs/getting-started.md) for the full walkthrough.

## For developers — building from source

```bash
mkdir capix-build && cd capix-build
git clone https://github.com/CapIX-Protocol/CapIX-Code.git capix-code
git -C capix-code checkout 80b48d576deea2ec36a44c505a6e7c6e3b87d088
(
  cd capix-code
  ./scripts/bootstrap.sh
  ./scripts/rebrand.sh
  ./scripts/install-config.sh
  ./scripts/build.sh
)

git clone https://github.com/CapIX-Protocol/CapIX-IDE.git
cd CapIX-IDE
nvm install 20.18.2
nvm use 20.18.2
test "$(node --version)" = "v20.18.2"
./scripts/bootstrap.sh
CAPIX_CODE_CUSTOMER_DIR=../capix-code/dist/customer ./scripts/dev.sh
```

This repository contains the CapixIDE product source, integrated modules, brand assets, and release pipeline. The bootstrap script prepares the generated editor-source workspace used by the build.

To package distributable installers:

```bash
CAPIX_CODE_CUSTOMER_DIR=../capix-code/dist/customer ./scripts/build.sh
# Current-platform output paths are listed in INSTALL.md.
./scripts/package-release.sh v2.3.17 darwin arm64
```

For CI/cross-platform release builds, tag a version and the [Release workflow](.github/workflows/release.yml) builds the four supported targets in parallel: macOS arm64/x64, Linux x64, and Windows x64.

## License

- **Capix IDE product overlay** (`extensions/`, `scripts/`, build configuration, docs): MIT, Copyright 2026 Capix.
- **Editor core**: MIT, Copyright Microsoft Corporation.

See `LICENSE`, `NOTICE`.

## Security

See [`SECURITY.md`](SECURITY.md) for our vulnerability reporting policy and security features.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, testing, and commit conventions.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for release history and changes.

## Links

- **Capix Protocol** — [capix.network](https://capix.network) · [github.com/CapIX-Protocol/Capix-Protocol](https://github.com/CapIX-Protocol/Capix-Protocol)
- **Capix Code** (CLI assistant) — [github.com/CapIX-Protocol/capix-code](https://github.com/CapIX-Protocol/capix-code)
