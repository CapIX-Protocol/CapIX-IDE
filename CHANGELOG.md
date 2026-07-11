# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `destroyPrivateLlm()` now uses authenticated `client.delete()` instead of `process.env.CAPIX_API_KEY` (billing bug fix). The method previously leaked the API key via environment variables and bypassed the authenticated client — it now goes through the Capix API client with proper Bearer token auth from SecretStorage.
- Build script error suppression removed — TypeScript compilation failures now halt the build instead of being silently swallowed.

### Added
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
- Bootstrap script now pins the Void editor to a specific commit SHA instead of tracking `main`.
- `product.json` `capixVersion` bumped to `1.1.0` to match the git tag.
- `electron-builder.yml` updated with macOS code signing and notarization config.
- README updated with honest Void editor attribution and security policy links.
