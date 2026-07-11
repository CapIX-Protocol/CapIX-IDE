# Contributing to CapixIDE

CapixIDE is a brand kit + builder pipeline built on the Void editor (a VS Code-based editor). The full VS Code source (~1GB) is cloned into `vscode/` by `scripts/bootstrap.sh` — it is NOT checked into this repo.

## Setup

```bash
git clone https://github.com/Ritzky/CapixIDE.git
cd CapixIDE
./scripts/bootstrap.sh   # clones Void + rebrands into ./vscode/
./scripts/dev.sh          # launches the dev Electron build
```

### Prerequisites

- **Node.js 20.18.2** — use `nvm install && nvm use` (check `.nvmrc` after bootstrap).
- **No spaces** in the repo folder path (VS Code build breaks otherwise).
- **macOS:** Python + Xcode (default), and **GNU libtool** (not BSD — `brew install libtool`). The macOS default `libtool` fails with `unrecognised option: '-static'`.
- **Linux:** `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`
- **Windows:** VS 2022 (or Build Tools) with Workloads `Desktop development with C++` and `Node.js build tools`; Individual components `MSVC v143 ... Spectre-mitigated libs`, `C++ ATL for Spectre Mitigations`, `C++ MFC for Spectre Mitigations`.

## Where things live

```
CapixIDE/
├── product.json                  # branding (nameShort, bundle id, icons, marketplace)
├── electron-builder.yml          # .dmg/.exe/.deb/.rpm/AppImage packaging config
├── scripts/
│   ├── bootstrap.sh              # clone Void + run rebrand
│   ├── rebrand.sh                # search-replace Void → CapixIDE across the tree
│   ├── dev.sh                    # launch dev Electron build (npm run watch + watchreact)
│   ├── build.sh                  # produce packaged app per platform
│   └── jetbrains-importer.mjs    # our JetBrains → VS Code settings translator
├── resources/
│   └── icons/                    # code.icns / code.ico / code.png for packaging
├── .github/workflows/
│   └── release.yml               # tag-triggered cross-platform CI build
├── docs/                         # getting-started, llm-deploy, contributing
├── NOTICE                        # attribution (Glass Devtools + Microsoft)
├── LICENSE                       # Apache-2.0
└── README.md
```

After `bootstrap.sh`, the VS Code source tree lives at `vscode/`:

```
vscode/
├── product.json                  # overwritten by our rebranded copy
├── src/vs/workbench/contrib/
│   └── capix/                    # renamed from void/ by rebrand.sh (chat panel, LLM dispatch)
│       ├── browser/react/        # the chat sidebar React app
│       ├── common/               # settings, model registry, sendLLMMessage service
│       └── electron-main/        # LLM HTTP calls (runs on main process, not browser)
├── scripts/code.sh               # dev launcher
└── … (rest is stock VS Code)
```

## Making changes

- **Rebrand changes** (product name, icons, bundle id, marketplace): edit `product.json` + `resources/icons/`, then re-run `scripts/rebrand.sh`.
- **Chat panel / AI provider behavior** (inherited from Void): edit `vscode/src/vs/workbench/contrib/capix/` after bootstrap. The fold rename from `void` to `capix` is applied by `rebrand.sh`; keep new code under that path.
- **Packaging config** (target formats, signing, publish): edit `electron-builder.yml`.
- **JetBrains importer**: edit `scripts/jetbrains-importer.mjs` — it's a standalone Node script, no VS Code build needed.

## Testing

### Extension tests (capix-llm)

```bash
cd extensions/capix-llm

# Run tests once
npm test

# Watch mode (auto-rerun on file change)
npm run test:watch

# Coverage report (text + lcov)
npm run test:coverage
```

### Linting & formatting

```bash
cd extensions/capix-llm

# Check formatting
npm run format:check

# Fix formatting
npm run format

# Lint
npm run lint

# Auto-fix lint issues
npm run lint:fix
```

### Full app build test

```bash
# Build a local exe for your platform (~25 min, needs the prereqs above):
cd vscode
./scripts/build.sh

# Or launch the dev build to test changes interactively:
./scripts/dev.sh
```

The full `npm test` suite from VS Code also runs after bootstrap, but it's heavy and rarely needed for rebrand-kit changes.

## Releasing

1. Bump `capixVersion` in `product.json`.
2. Tag: `git tag v1.1.0 && git push origin v1.1.0`.
3. The [Release workflow](../.github/workflows/release.yml) builds all platform/arch combos in parallel and uploads to GitHub Releases.
4. The auto-updater (inherited from Void, rewired to this repo's Releases) notifies existing users.

## License

By contributing, you agree your contributions are licensed under MIT (same as the rest of CapixIDE).
