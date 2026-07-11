# macOS Notarization Setup

CapixIDE macOS builds must be code-signed and notarized to pass Gatekeeper
without user warnings. This document covers the one-time setup and the
GitHub Actions secrets required.

## Prerequisites

1. **Apple Developer Program membership** (USD $99/year) — enroll at
   [developer.apple.com/programs](https://developer.apple.com/programs/).

2. **Developer ID Application certificate** — create at
   [certificates.apple.com](https://certificates.apple.com):
   - Type: `Developer ID Application`
   - This produces a `.p12` file used for code signing.

3. **App-specific password** for notarization — create at
   [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
   App-Specific Passwords. Used for `xcrun notarytool` submission.

## Export the signing certificate

```bash
# From Keychain Access, export the "Developer ID Application" certificate
# as a .p12 file with a password. Then base64-encode it for GitHub Secrets:

base64 -i developer-id.p12 -o cert-base64.txt
```

## GitHub Actions secrets

Set these in the CapixIDE repo → Settings → Secrets and variables → Actions:

| Secret name | Value |
|---|---|
| `APPLE_DEVELOPER_ID` | Your Developer ID Application identity string (e.g. `Developer ID Application: Your Name (TEAMID123)`) |
| `APPLE_TEAM_ID` | Your Apple Team ID (10-character alphanumeric, found in developer.apple.com/account) |
| `APPLE_ID` | Your Apple ID email address (for notarytool submission) |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password created above |
| `APPLE_CERTIFICATE_BASE64` | The base64-encoded `.p12` file contents |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` export password |

## How it works

- `electron-builder.yml` has `notarize: { teamId }` and `identity` configured
  to read from env vars (`APPLE_TEAM_ID`, `APPLE_DEVELOPER_ID`).
- `release.yml` passes all Apple secrets as env vars to the `electron-builder`
  packaging step.
- When `APPLE_DEVELOPER_ID` is set, electron-builder automatically:
  1. Signs the app with the Developer ID certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`)
  2. Submits to Apple's notarization service via `xcrun notarytool`
  3. Staples the notarization ticket to the `.dmg`
- If secrets are NOT set (e.g. PR builds), the build proceeds unsigned —
  this is acceptable for CI/dev but **must not** be shipped to users.

## Verification

After a release build, verify on macOS:

```bash
spctl --assess --verbose=4 CapixIDE-x.x.x-arm64.dmg
# Should print: CapixIDE-x.x.x-arm64.dmg: accepted
# source=Notarized Developer ID
```

If the output says "source=unsigned" or Gatekeeper blocks it, the notarization
secrets were not set during the build.
