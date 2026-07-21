# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Capix webviews rendered raw `$(codicon)` tokens (`$(add)`, `$(history)`, `$(chrome-maximize)`, …) as literal text — every panel now renders crisp inline SVG icons through a shared `webviewIcons` helper (`capix-llm`, `capix-intelligence`).
- Tree views passed invalid `$(name)` / `~spin` strings to `vscode.ThemeIcon`, producing blank icons; all tree items now use bare codicon IDs (`capix-llm`, `capix-cloud`, `capix-workspace`).
- Transient 401/503 responses from the Capix API no longer spam error notifications; tree providers log quietly and self-heal on the next refresh.
- `capix-cloud` palette commands declared in `package.json` were never registered, so Deploy / Billing / Receipt commands did nothing — all commands are now wired up, and View Receipt falls back to an invoice picker.
- Removed stale compiled `extensions/capix-llm/out/` artifacts that were committed by accident.
- `destroyPrivateLlm()` now uses authenticated `client.delete()` instead of `process.env.CAPIX_API_KEY` (billing bug fix). The method previously leaked the API key via environment variables and bypassed the authenticated client — it now goes through the Capix API client with proper Bearer token auth from SecretStorage.
- Build script error suppression removed — TypeScript compilation failures now halt the build instead of being silently swallowed.

### Added
- Cursor-style default layout: on first run the Capix Code chat docks in the secondary side bar (right side) — applied once per profile and never overriding a user's own arrangement (`capix-layout` workbench module + patch `0010`).
- One-line, checksum-verified installers: `scripts/ide-install.sh` (macOS/Linux) and `scripts/ide-install.ps1` (Windows).
- Inline completion enabled by default (`capix.ai.autocomplete.enabled`, `capix.inlineCompletion.enabled`, `editor.inlineSuggest.enabled`), secondary side bar visible by default, minimap off, shrinking tabs — a clean first-run editor.
- `delete` method to the `CapixClient` constructor type interface for `SmartRouterManager`.
- Community health files: `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`.
- Prettier + ESLint flat config for the `capix-llm` extension.
- Vitest test framework with coverage thresholds.
- Husky + lint-staged pre-commit hooks.
- Commitlint with conventional commits config.
- Structured logger (`src/logger.ts`) with VS Code OutputChannel integration.
- Opt-in crash reporting telemetry (`src/telemetry.ts`).
- `validateBaseUrl` enforcement in `CapixClient` — non-HTTPS URLs are rejected.
- Silent catch blocks replaced with proper error logging across all extension source files.
- Test suite: `smartRouterManager.test.ts`, `terminalManager.test.ts`, `apiClient.test.ts`.

### Changed
- README now leads with one-line install commands; stale `Ritzky/…` GitHub org links point to `CapIX-Protocol/…`.
- `CONTRIBUTING.md` clone URL updated to `CapIX-Protocol/CapIX-IDE`.
- Bootstrap script now pins the Void editor to a specific commit SHA instead of tracking `main`.
- `product.json` `capixVersion` bumped to `1.1.0` to match the git tag.
- `electron-builder.yml` updated with macOS code signing and notarization config.
- README updated with honest Void editor attribution and security policy links.
