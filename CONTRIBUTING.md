# Contributing to CapixIDE

CapixIDE is a VS Code extension + rebrand kit built on top of the Void editor (a VS Code fork). Thanks for your interest in contributing!

## Getting Started

### Prerequisites

- **Node.js 20.18.2** — use `nvm install && nvm use` (check `.nvmrc` after bootstrap).
- **No spaces** in the repo folder path (VS Code build breaks otherwise).
- **macOS:** Python + Xcode (default), and **GNU libtool** (not BSD — `brew install libtool`).
- **Linux:** `sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3`
- **Windows:** VS 2022 (or Build Tools) with Workloads `Desktop development with C++` and `Node.js build tools`; Individual components `MSVC v143 ... Spectre-mitigated libs`, `C++ ATL for Spectre Mitigations`, `C++ MFC for Spectre Mitigations`.

### Dev Setup

```bash
git clone https://github.com/Ritzky/CapixIDE.git
cd CapixIDE
./scripts/bootstrap.sh   # clones the Void editor source + applies the Capix rebrand
cd extensions/capix-llm && npm install
cd ../..
./scripts/dev.sh         # launches the dev build
```

### Building from Source

```bash
./scripts/build.sh       # builds the app for your current platform
npx electron-builder --mac --arm64 --config electron-builder.yml
```

## Development Workflow

### Branching

1. Branch from `main`:
   ```bash
   git checkout -b feature/my-feature
   ```
2. Make your changes.
3. Ensure CI passes and tests pass (see below).
4. Open a Pull Request against `main`.
5. Request review from a maintainer.
6. Merge after approval.

### Running Tests (capix-llm extension)

```bash
cd extensions/capix-llm

# Run tests once
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

### Linting & Formatting

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

### Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`.

Examples:
```
feat: add model catalog search filter
fix: correct billing API auth header in destroyPrivateLlm
docs: update contributing guide with test commands
test: add smartRouterManager lifecycle tests
chore: pin Void upstream to specific commit
```

Husky + lint-staged run automatically on commit to enforce formatting and lint rules.

## License

By contributing, you agree your contributions are licensed under the MIT License (same as the rest of CapixIDE).
