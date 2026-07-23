# Changelog

## 2.3.18

- Remove a duplicate release-workflow cleanup that ran after the idempotent rebrand cleanup and caused every Unix artifact build to fail.
- Bundle the Capix Code 2.4.11 runtime with signed-out MCP registration and broker-backed authentication recovery.
- Preserve the built-in authentication isolation, Cloud Hub jobs readiness, and full cross-platform release gates from 2.3.17.

## 2.3.17

- Isolate the built-in Capix Code runtime from the standalone CLI credential broker so IDE sign-in cannot enter a competing refresh loop.
- Restore Cloud Hub jobs and native Capix Code readiness while keeping authentication inside the IDE secure-storage boundary.
- Carry forward the immutable Capix Code 2.4.10 runtime and the complete cross-platform release gates from 2.3.16.

## 2.3.16

- Bind every customer artifact to an immutable source tag and the Capix Code 2.4.10 runtime.
- Require all four platform builds, compiled runtime registration, extension tests, customer branding, SBOM, provenance, notices, and checksums before publication.
- Document the unsigned portable release channel and verified source-build prerequisites accurately.

## 2.3.15

- Preserve the Code-OSS 1.x extension-host API version while keeping CapixIDE's customer-facing 2.3.15 release version, restoring built-in language servers and extension activation.
- Remove inherited remote-client source and marketplace packages from local and CI builds.
- Harden the release verifier and repair the IDE extension test harnesses; 339 extension tests pass.

## 2.3.14

- Bundle the immutable Capix Code 2.4.9 runtime with the latest Capix Intelligence and Smart Router release gates.
- Publish the macOS, Linux, and Windows artifacts atomically only after every mandatory archive and checksum exists.
- Keep customer installation and build terminology Capix-native.

## 2.3.13

- Add a stable idempotency key to every native Capix inference stream, including authentication-refresh retries, so IDE chat requests satisfy the production gateway contract without risking duplicate billing.
- Make the release verifier fail closed when the native inference transport omits idempotency protection.
- Correct customer release instructions to describe the portable, checksummed archives actually published by CI.

## 2.3.12

- Bundle the immutable Capix Code 2.4.6 runtime whose cross-platform publication pipeline is fully verified.

## 2.3.11

- Bundle the immutable Capix Code 2.4.5 runtime with corrected, fully branded release metadata.

## 2.3.10

- Pin the single-publisher Capix Code 2.4.4 runtime for coherent cross-platform releases.

## 2.3.9

- Bundle the immutable Capix Code 2.4.3 runtime and its corrected cross-platform release packaging.

## 2.3.8

- Bundle the immutable Capix Code 2.4.2 runtime with merged-balance support.
- Refresh the macOS, Linux, and Windows customer installation guide to current verified release names.

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
