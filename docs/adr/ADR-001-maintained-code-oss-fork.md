# ADR-001: Migrate CapixIDE to a maintained Code-OSS fork

- **Status:** Accepted
- **Date:** 2026-07-11
- **Workstream:** I1 — Migrate to an owned Code-OSS fork (architecture §11.1, master prompt §10)
- **Supersedes:** `scripts/bootstrap.sh` clone-at-build model
- **Depends on:** ADR-I0 (preserve and understand the current fork)

## Context

CapixIDE today is built from a **clone-at-build** script. `scripts/bootstrap.sh` runs:

```bash
git clone --depth 1 https://github.com/voideditor/void.git "$VSCODE"
cd "$VSCODE" && git checkout "$VOID_COMMIT"   # b3166e7ef2aefbdfeb139445fdf248a561b85d4d
```

It then applies `scripts/rebrand.sh`, which copies `product.json`, an `capix-llm` extension, icons and a settings-defaults JSON on top of the upstream tree. The consequences of this model are:

1. **No owned source history.** The `vscode/` directory is a *shallow, detached* clone whose `origin` points at `voideditor/void`. Capix owns none of the commits that produce the shipped binary; the only owned artifact is a rebrand overlay applied after checkout. A `git log` of the shipped source is the Void history, not a Capix history.
2. **No reproducibility guarantee.** `--depth 1` plus a recorded commit SHA is stability theater: the Void remote can be force-pushed, deleted or archived, and a fresh clone can land a different tree if the commit is lost. The commit is pinned only in a shell variable, not in Capix history, and there is no signed or reviewed Capix commit that records what was actually shipped.
3. **No reviewable patch surface.** Every Capix behavior (branding, settings defaults, bundled extension) lives outside source control as a copy step. There is no reviewable diff between upstream and the shipped tree, so a security review cannot answer "what did Capix change and why".
4. **No upstream security cadence.** Capix does not own the merge of Chromium, Electron, Node or Code-OSS security patches. The Void upstream is archived (read-only), so the fork is effectively frozen and will drift from current Code-OSS the moment it is cloned.
5. **Hidden second product boundary.** The rebrand drops settings defaults into `src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx/`, preserving a Void settings store, Void provider path and Void identity inside the Capix-branded product. This violates architecture §11.1: "Void is not a hidden second product boundary or settings store."
6. **CI builds a moving target.** CI does not build the checked-out commit; it clones and rebrands at build time, so the artifact is a function of whatever the clone produces on that run, not of a reviewed Capix commit.

CapixIDE is the canonical signed desktop product and the primary graphical surface for the Capix protocol (architecture §1, §11.1). It cannot be a rebrand overlay on an archived upstream if it is to own updates, signing, the remote server, the agent runtime, the onboarding flow and the AI UI.

## Decision

CapixIDE becomes a **maintained Code-OSS fork** with real, owned git history.

- Capix bases the fork on a **supported Code-OSS release line** (not the archived Void tree) and records the upstream commit, Electron/Node versions, security support window and licenses in a manifest.
- Capix **preserves the upstream history and remotes** (`microsoft/vscode` as `upstream`, the Code-OSS/VSCodium lineage as appropriate) so security merges are real `git merge`/`cherry-pick` operations with reviewable history, not destructive re-clone steps.
- All Capix behavior — branding, onboarding, AI UI, auth broker, remote authority, settings defaults, menus, protocol handler, icons/themes, updater — lands as **reviewable commits grouped into platform primitives, Capix AI, Capix Remote, built-in product modules, packaging and release** (architecture §11.1).
- The `capix-*` contrib modules under `src/vs/workbench/contrib/capix-{auth,ai,remote,onboarding}/` are the **owned, first-party** location for Capix product behavior. Code-OSS/Void/OpenCode/extension/third-party licensing is resolved in every artifact and notice set.
- Capix **owns the release branches**, the upstream security merges, the signing keys, the updater, the `capix-server` build and the compatibility manifest. Desktop, `capix-server`, built-ins and runtime are built from **one checked-out commit**.

### Invariants the fork must uphold

1. **Owned history.** `git log` of the shipped tree is a Capix history that records every change, its author and its review.
2. **Reproducible source.** A clean checkout of a Capix commit, with no clone/rebrand step, produces the Capix-branded desktop and matching `capix-server`.
3. **CI builds the checked-out commit.** CI never clones a moving upstream tip at build time. The upstream merge is a separate, reviewed Capix commit.
4. **No hidden Void boundary.** Clean install never displays Void, asks for Void providers, or carries Void settings/telemetry/update boundaries. The Void onboarding/settings/provider/chat/agent path is ported into `contrib/capix-*` or removed.
5. **Capix owns product identity.** `capix.baseUrl`, update origin and auth origin are product/admin settings; a malicious `.vscode/settings.json` cannot redirect wallet bearer tokens (architecture §11.2).

## Consequences

**Positive:**
- Capix owns every patch that ships. A security review can answer "what did Capix change" from history alone.
- Upstream Code-OSS, Electron, Node and Chromium security updates merge into owned release branches with a tracked, signed cadence.
- Release artifacts are reproducible from a signed Capix commit; the artifact is a function of the commit, not of a clone-at-build run.
- `capix-server`, the bundled Capix Agent Runtime, built-in extensions and desktop share one release manifest and one compatibility window (architecture §17.4).
- The `capix-*` contrib boundary makes the main↔renderer↔agent process model explicit (architecture §11.2) and lets the auth broker, AI service and remote authority be code-reviewed and fuzz-tested as first-party code.

**Negative / obligations:**
- Capix must staff the ongoing merge of upstream Code-OSS and Electron security releases. This is real maintenance work, not a one-time clone.
- Capix must maintain the upstream security SLA (below) and a compatibility suite that gates every merge.
- The fork must keep merge conflict resolution reviewable; large divergences from upstream become expensive. Capix must prefer supported upstream plugin/provider/server contracts over broad source rewrites (architecture §11.5).
- Trademark, gallery, license and redistribution obligations for Code-OSS, Void, OpenCode and every included extension must be resolved in the notice set (master prompt I1 exit gate).

## Alternatives considered

### A. Continue clone-at-build (status quo) — **Rejected**

Keep `bootstrap.sh` cloning `voideditor/void` at a pinned commit with `rebrand.sh` on top.

- *Rejected because:* Capix owns no history and cannot guarantee reproducibility. A `git log` of the shipped tree is the Void history. The Void upstream is archived, so the fork is frozen and will not receive Code-OSS, Electron or Chromium security patches. There is no reviewable Capix diff, no upstream security cadence, and a hidden Void settings/product boundary persists inside the Capix-branded product. This violates architecture §1.2 and §11.1 and the master prompt invariant: "CapixIDE is a maintained Code-OSS fork, not a clone-at-build or mass-rebrand script."

### B. Submodule the upstream — **Rejected**

Keep CapixIDE as a thin repo with `vscode/` as a git submodule pinned to an upstream commit, plus a patch overlay.

- *Rejected because:* a submodule re-introduces clone-at-build semantics under a different name. The shipped tree is still the upstream tree plus an out-of-tree overlay; Capix still owns no in-tree commits for product behavior, and the rebrand boundary (Void settings store, Void provider path) survives. It also complicates the "one checked-out commit builds desktop and server" invariant.

### C. Extension-first launch (install a separate VS Code extension) — **Rejected**

Ship CapixIDE as stock VS Code plus a "Capix" extension, per architecture §1.1 ("This architecture does not use an extension-first launch strategy").

- *Rejected because:* built-in extensions are internal modules shipped with the signed app; the customer path is the signed standalone product. An extension-first launch cannot own first-run identity, the updater, the remote server, the auth broker or the process/security boundary, and cannot prevent a second product identity (VS Code + extension) from leaking into the customer experience.

## Migration plan

The migration follows master prompt I0 → I1. Each step has an exit gate. The old clone-at-build path is retained only for internal comparison until parity is proven; it is **not** a production path.

### Step 0 — Preserve and understand the current fork (I0)

- Capture root and nested `vscode` git state, the exact Void/Code-OSS commit, Electron/Node/toolchain, build/release behavior, licenses and local changes.
- Run current compile/test/lint/build/package checks without treating suppressed failures as passes.
- Map every Capix extension setting/secret/command/view to its actual consumer or prove it is dead.
- Map the inherited Void onboarding/settings/provider/chat/agent path and identify which components will be ported (into `contrib/capix-*`) versus removed.
- Record dirty/generated `out` differences; never hand-edit stale compiled output.
- Keep the current rebrand build available for internal comparison, labelled non-production.

**Exit gate:** A documented migration map accounts for every current customer claim and every locally changed file; no user change is overwritten.

### Step 1 — Select a supported Code-OSS release

- Choose a supported Code-OSS stable line that is still receiving security updates and has a clear Electron/Node toolchain and license/redistribution path.
- Record in a `release-manifest` the upstream commit, Electron version, Node version, Code-OSS security support window, gallery policy (open-vsx) and all third-party licenses.

### Step 2 — Preserve upstream history/remotes

- Import the upstream as a real history into the CapixIDE repo (not a shallow clone). Keep `upstream` remote pointing at the supported Code-OSS line.
- Capix changes land as reviewable commits on Capix-owned branches; no detached nested clone, no in-place rebrand overlay.

### Step 3 — Port Capix changes as reviewable commits

- Port product identity, onboarding, settings defaults, menus, walkthroughs, protocol handler (`capix://`), endpoints, icons/themes and updater into source.
- Port the required AI/editor behavior into `src/vs/workbench/contrib/capix-{auth,ai,remote,onboarding}/`. Remove hidden Void identity/provider/settings/telemetry/update boundaries.
- Migrate customer settings through a versioned, tested schema. Clean install never displays Void or asks for Void providers.
- Generate complete Code-OSS/Void/OpenCode/extension/third-party notices and a redistribution review.

### Step 4 — CI builds the checked-out commit

- CI builds from the checked-out Capix commit. It never clones a moving upstream tip, never runs a rebrand overlay, and never publishes from a raw build directory.
- Build desktop, `capix-server`, built-ins and the compatibility manifest from the same commit. Every release includes checksums, SBOM, third-party notices, build provenance, source SHA, API/schema range, `capix-server`/agent/runtime versions and signatures (architecture §11.7, §17.3).

**Exit gate (I1):** A clean checked-out source produces a reproducible Capix-branded internal desktop and matching server without rebrand scripts or a moving upstream checkout.

### Step 5 — Fall-back: frozen Void baseline for internal alpha only

- The frozen Void baseline (`scripts/bootstrap.sh`) is retained **only** as a fall-back for internal alpha comparison and is explicitly labelled non-production.
- GA requires Capix to accept ongoing maintenance ownership. The fall-back must not be the customer-shipped path and must not carry the Void settings/provider/product boundary into any signed release.

## Upstream security SLA

This SLA gates the maintained fork's acceptability for GA. Every merge is a reviewed Capix commit onto a release branch and is exercised by the compatibility suite before the release manifest is updated (architecture §14.5, §17.4).

| Severity | Examples | Capix response target |
|---|---|---|
| Critical | RCE in Electron/Code-OSS/Chromium shipped to the desktop, auth-broker bypass, update-channel compromise, remote-authority/tunnel credential disclosure | Critical patch merged, signed and released within **72 hours** of upstream disclosure, with a compatibility-suite run and a regression test for the patched path. |
| Minor/High | Privilege escalation, sandbox escape into the workspace, settings/origin redirect, non-critical RCE in an included extension | Fix merged within **2 weeks** of upstream availability, exercised on the release candidate ring before stable. |

Operational rules:

- Once a fix is on a release branch it advances through internal → beta → stable rings with percentage rollout and rollback protection (architecture §11.7). Any compile/test/package/sign/notarize/post-sign clean-install failure prevents publication.
- The compatibility suite proves the merge does not break the agent runtime, `capix-server`, the auth broker, the remote authority or the bundled extensions across the supported platform matrix. A material auth, money, lifecycle, data-plane or schema change resets the four-week SLO evidence window (architecture §16.2).
- Where a third-party component (Void, OpenCode, an included extension) has no upstream security path, Capix assumes full maintenance ownership of that component or removes it before GA. The frozen Void baseline is acceptable for internal alpha only.

## References

- Architecture §1 (decisions 1–2), §11.1 (product and fork model), §11.2 (process/security boundaries), §11.7 (packaging and update), §14.5 (supply chain), §17.1–17.4 (repository/CI/release), §20 (non-negotiable invariants).
- Master prompt §10: I0 (preserve and understand the current fork), I1 (migrate to an owned Code-OSS fork), I2 (desktop security/process boundary).
- RFC 8252 (OAuth 2.0 for Native Apps) — informs why auth and the broker must be first-party main-process code.
- Current state: `scripts/bootstrap.sh`, `scripts/rebrand.sh`, `product.json` (Void pinned commit `b3166e7ef2aefbdfeb139445fdf248a561b85d4d`).
