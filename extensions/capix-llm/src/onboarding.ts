/**
 * OnboardingFlow — a first-run experience that gets to "aha" in 60 seconds.
 *
 * Opens a full-editor webview with a calm, spacious welcome screen:
 *  1. Welcome to Capix (logo + tagline)
 *  2. Sign in button (or "I already have an account")
 *  3. After sign-in: balance chip ($1 free credit)
 *  4. Quick start: "Deploy your first app" — scaffolds a Next.js template,
 *     opens it, and routes to the Capix Cloud deploy.
 *  5. Quick start: "Chat with a model" — opens Capix Code + sends a test turn.
 *  6. Quick start: "Explore the Cloud" — focuses the cloud dashboard.
 *  7. "Get started" — applies the editor layout and closes onboarding.
 *
 * Design tokens (@capix/ui-tokens):
 *  • Background #0a0e14
 *  • Capix cyan #3DCED6 for buttons and accents
 *  • Green primary #14F195
 *  • Plus Jakarta Sans for text, JetBrains Mono for code
 */

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { CapixClient } from "./apiClient";
import { applyLayout } from "./layoutPresets";
import { logger } from "./logger";

export interface OnboardingHooks {
  /** Send a test message into the Capix Code panel. */
  sendChatMessage: (text: string) => void;
  /** Reveal / focus the Cloud dashboard. */
  focusCloud: () => void;
}

type DeployStage = "idle" | "scaffolding" | "deploying" | "done";

export class OnboardingFlow {
  private panel?: vscode.WebviewPanel;
  private configured = false;
  private balanceUsd = "1.00";
  private deployStage: DeployStage = "idle";
  private deployUrl: string | undefined;
  private pollHandle: NodeJS.Timeout | null = null;

  constructor(
    private client: CapixClient,
    private extensionUri: vscode.Uri,
    private hooks: OnboardingHooks,
  ) {}

  async start(context: vscode.ExtensionContext): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, false);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "capix.onboarding",
      "Welcome to Capix",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: false,
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      "resources",
      "capix-icon.png",
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.pollHandle) {
        clearInterval(this.pollHandle);
        this.pollHandle = null;
      }
    });
    this.panel.webview.onDidReceiveMessage((msg) =>
      this.handleMessage(msg as { type: string }, context),
    );
    await this.showWelcome(this.panel.webview);
    await this.refreshState();
    // Lightly poll so the balance + sign-in state stay fresh while the panel is
    // open (covers the OAuth round-trip the user begins in the browser).
    this.pollHandle = setInterval(() => {
      void this.refreshState();
    }, 15_000);
  }

  async showWelcome(webview: vscode.Webview): Promise<void> {
    const nonce = randomBytes(16).toString("base64");
    webview.html = this.getHtml(nonce);
  }

  /** Quick start: scaffold a simple Next.js template and route to deploy. */
  async deployFirstApp(): Promise<void> {
    if (!this.configured) {
      this.post({ type: "error", message: "Sign in to deploy your first app." });
      return;
    }
    this.deployStage = "scaffolding";
    this.post({ type: "deployProgress", stage: "scaffolding" });
    try {
      const folder = await this.resolveScaffoldFolder();
      await this.scaffoldNextApp(folder);
      const pageUri = vscode.Uri.joinPath(folder, "app", "page.tsx");
      const doc = await vscode.workspace.openTextDocument(pageUri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });

      this.deployStage = "deploying";
      this.deployUrl = `${this.client.getBaseUrl()}/cloud/websites`;
      this.post({ type: "deployProgress", stage: "deploying", url: this.deployUrl });
      await vscode.env.openExternal(vscode.Uri.parse(this.deployUrl));

      this.deployStage = "done";
      this.post({ type: "deployProgress", stage: "done", url: this.deployUrl });
    } catch (err) {
      logger.error("Onboarding.deployFirstApp failed", { error: String(err) });
      this.post({
        type: "error",
        message: "Could not scaffold the starter app. Try again or open the Cloud to deploy manually.",
      });
      this.deployStage = "idle";
      this.post({ type: "deployProgress", stage: "idle" });
    }
  }

  /** Quick start: open Capix Code on the right and send a test message. */
  async chatFirstMessage(): Promise<void> {
    if (!this.configured) {
      this.post({ type: "error", message: "Sign in to chat with a model." });
      return;
    }
    this.hooks.sendChatMessage(
      "Hello Capix — give me a quick tour of what you can do in this workspace.",
    );
    this.post({ type: "chatOpened" });
  }

  /** Quick start: open the cloud dashboard. */
  async exploreCloud(): Promise<void> {
    this.hooks.focusCloud();
    this.post({ type: "explored" });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private handleMessage(msg: { type: string }, context: vscode.ExtensionContext): void {
    switch (msg.type) {
      case "signIn":
        void vscode.commands.executeCommand("capix.resetSessionAndSignIn");
        break;
      case "deploy":
        void this.deployFirstApp();
        break;
      case "chat":
        void this.chatFirstMessage();
        break;
      case "explore":
        void this.exploreCloud();
        break;
      case "getStarted":
        void this.getStarted(context);
        break;
      case "refresh":
        void this.refreshState();
        break;
    }
  }

  private async getStarted(context: vscode.ExtensionContext): Promise<void> {
    try {
      await applyLayout("editor", context);
    } catch (err) {
      logger.warn("Onboarding.getStarted applyLayout failed", {
        error: String(err),
      });
    }
    this.panel?.dispose();
  }

  private async refreshState(): Promise<void> {
    try {
      const wasConfigured = this.configured;
      this.configured = await this.client.checkConfigured();
      if (this.configured && !wasConfigured) {
        const bal = await this.client.getBalance().catch(() => null);
        if (bal?.ok && bal.balance) this.balanceUsd = bal.balance.usd;
      }
    } catch (err) {
      logger.warn("Onboarding.refreshState failed", { error: String(err) });
    }
    this.post({
      type: "state",
      configured: this.configured,
      balanceUsd: this.balanceUsd,
      deployStage: this.deployStage,
      deployUrl: this.deployUrl,
    });
  }

  private async resolveScaffoldFolder(): Promise<vscode.Uri> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) return vscode.Uri.joinPath(ws.uri, "capix-starter");
    const stamp = `${Date.now()}`;
    return vscode.Uri.file(path.join(os.tmpdir(), `capix-starter-${stamp}`));
  }

  private async scaffoldNextApp(folder: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, "app"));
    await this.write(folder, "package.json", PACKAGE_JSON);
    await this.write(folder, "next.config.mjs", NEXT_CONFIG);
    await this.write(folder, "app/layout.tsx", APP_LAYOUT);
    await this.write(folder, "app/page.tsx", APP_PAGE);
    await this.write(folder, ".gitignore", GITIGNORE);
    await this.write(folder, "README.md", README_MD);
  }

  private async write(folder: vscode.Uri, rel: string, content: string): Promise<void> {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folder, rel),
      Buffer.from(content, "utf8"),
    );
  }

  private post(message: Record<string, unknown>): void {
    this.panel?.webview.postMessage(message);
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private getHtml(nonce: string): string {
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      `script-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<title>Welcome to Capix</title>
<style>${ONBOARDING_STYLES}</style>
</head>
<body>
  <div class="bg-glow" aria-hidden="true"></div>

  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">${LOGO_SVG}</span>
      <span class="brand-name">Capix</span>
    </div>
    <button class="balance-chip" id="balance-chip" data-cmd="refresh" title="Refresh" hidden>
      <span class="dot"></span>
      <span id="balance-label">$1.00 free credit</span>
    </button>
  </header>

  <main class="shell">
    <!-- Pre sign-in -->
    <section class="hero signed-out" id="hero-signedout">
      <h1 class="hero-title">Welcome to <span class="accent">Capix</span></h1>
      <p class="hero-sub">The operating system for distributed compute — route inference, agents, and apps across a global GPU network in seconds.</p>
      <div class="cta-row">
        <button class="btn btn-primary" data-cmd="signIn">Sign in — get $1 free credit</button>
        <button class="btn btn-ghost" data-cmd="signIn">I already have an account</button>
      </div>
      <p class="micro">By continuing you agree to the Capix terms. No card required.</p>
    </section>

    <!-- Post sign-in -->
    <section class="hero signed-in" id="hero-signedin" hidden>
      <div class="hero-head">
        <h1 class="hero-title">You're in. <span class="accent">Let's ship something.</span></h1>
        <p class="hero-sub">Three quick starts — pick one and see what Capix can do.</p>
      </div>

      <div class="cards">
        <button class="card" data-cmd="deploy" id="card-deploy">
          <span class="card-icon deploy">${ROCKET_SVG}</span>
          <span class="card-title">Deploy an app</span>
          <span class="card-desc">Scaffold a Next.js starter and publish it to the Capix Cloud.</span>
          <span class="card-cta" id="deploy-cta">Get a live URL →</span>
          <div class="card-progress" id="deploy-progress" hidden>
            <span class="progress-text" id="deploy-text">Scaffolding…</span>
            <a class="live-url" id="deploy-url" href="#" hidden target="_blank" rel="noopener"></a>
          </div>
        </button>

        <button class="card" data-cmd="chat" id="card-chat">
          <span class="card-icon chat">${CHAT_SVG}</span>
          <span class="card-title">Chat with AI</span>
          <span class="card-desc">Open Capix Code on the right and send your first message.</span>
          <span class="card-cta" id="chat-cta">Open Capix Code →</span>
        </button>

        <button class="card" data-cmd="explore" id="card-explore">
          <span class="card-icon cloud">${CLOUD_SVG}</span>
          <span class="card-title">Explore the Cloud</span>
          <span class="card-desc">Balance, instances, private models, and usage — in one dashboard.</span>
          <span class="card-cta" id="explore-cta">Open the Cloud →</span>
        </button>
      </div>
    </section>
  </main>

  <footer class="footer">
    <span class="footer-text">Spawn a GPU, deploy a model, ship an app — all without leaving the IDE.</span>
    <button class="btn btn-link" data-cmd="getStarted">Get started →</button>
  </footer>

  <div class="toast" id="toast" hidden></div>

  <script nonce="${nonce}">${ONBOARDING_SCRIPT}</script>
</body>
</html>`;
  }
}

// ── Scaffold template files ──────────────────────────────────────────────────

const PACKAGE_JSON = `{
  "name": "capix-starter",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
`;

const NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};
export default nextConfig;
`;

const APP_LAYOUT = `export const metadata = { title: "Capix Starter" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const APP_PAGE = `export default function Home() {
  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#0a0e14",
      color: "#3DCED6",
      fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{ textAlign: "center" }}>
        <h1>Live on Capix</h1>
        <p>Deployed from CapixIDE in under a minute.</p>
      </div>
    </main>
  );
}
`;

const GITIGNORE = `node_modules
.next
out
.env*.local
`;

const README_MD = `# Capix Starter

A minimal Next.js app scaffolded by CapixIDE onboarding.

## Develop

\`\`\`bash
npm install
npm run dev
\`\`\`

## Deploy

Push this folder to a Git repo and connect it on the
[Capix Cloud](https://www.capix.network/cloud/websites) to go live.
`;

// ── Inline SVGs ──────────────────────────────────────────────────────────────

const LOGO_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.4" fill="currentColor"/></svg>`;
const ROCKET_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 9-10c2.5 0 5 2.5 5 5a22 22 0 0 1-10 9z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.1 4-.5 4-.5"/><path d="M12 15v5s3.03-.55 4-2c1.1-1.62.5-4 .5-4"/></svg>`;
const CHAT_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/></svg>`;
const CLOUD_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.5-8.74A6 6 0 0 0 4.2 12.5 4 4 0 0 0 6 20h11.5z"/></svg>`;

// ── Styles + script ──────────────────────────────────────────────────────────

const ONBOARDING_STYLES = `
  :root {
    --capix-bg: #0a0e14;
    --capix-bg-elev: #11161f;
    --capix-surface: rgba(255,255,255,0.04);
    --capix-surface-hover: rgba(255,255,255,0.07);
    --capix-border: rgba(255,255,255,0.09);
    --capix-border-strong: rgba(61,206,214,0.28);
    --capix-fg: #e6edf3;
    --capix-muted: rgba(230,237,243,0.6);
    --capix-faint: rgba(230,237,243,0.38);
    --capix-cyan: #3DCED6;
    --capix-cyan-soft: rgba(61,206,214,0.12);
    --capix-green: #14F195;
    --capix-amber: #FFAE00;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
    color: var(--capix-fg);
    background: var(--capix-bg);
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
  }
  .bg-glow {
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(60% 50% at 15% 0%, rgba(61,206,214,0.10), transparent 70%),
      radial-gradient(50% 45% at 95% 10%, rgba(20,241,149,0.07), transparent 70%);
  }
  .topbar {
    position: relative; z-index: 2;
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 32px;
  }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--capix-cyan); }
  .brand-name { font-weight: 800; font-size: 18px; letter-spacing: -0.01em; color: var(--capix-fg); }
  .balance-chip {
    display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
    background: var(--capix-cyan-soft); color: var(--capix-cyan);
    border: 1px solid var(--capix-border-strong);
    border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600;
    font-family: inherit;
  }
  .balance-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--capix-green); box-shadow: 0 0 8px var(--capix-green); }
  .balance-chip:hover { background: rgba(61,206,214,0.18); }

  .shell {
    position: relative; z-index: 2;
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 24px 32px 48px; text-align: center;
  }
  .hero { max-width: 920px; width: 100%; }
  .signed-in { display: block; }
  .hero-title { font-size: 44px; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 14px; }
  .accent { color: var(--capix-cyan); }
  .hero-sub { font-size: 16px; line-height: 1.6; color: var(--capix-muted); margin: 0 auto 30px; max-width: 560px; }
  .cta-row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-bottom: 14px; }
  .btn {
    font-family: inherit; cursor: pointer; border-radius: 12px; border: 1px solid transparent;
    font-size: 14px; font-weight: 600; padding: 12px 22px; transition: transform .12s ease, background .15s ease, border-color .15s ease;
  }
  .btn:active { transform: translateY(1px); }
  .btn-primary { background: var(--capix-cyan); color: #06121b; }
  .btn-primary:hover { background: #54e0e8; }
  .btn-ghost { background: var(--capix-surface); color: var(--capix-fg); border-color: var(--capix-border); }
  .btn-ghost:hover { background: var(--capix-surface-hover); }
  .btn-link { background: transparent; color: var(--capix-cyan); padding: 8px 4px; border: none; }
  .btn-link:hover { text-decoration: underline; }
  .micro { font-size: 12px; color: var(--capix-faint); margin: 0; }

  .hero-head { margin-bottom: 28px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  @media (max-width: 820px) { .cards { grid-template-columns: 1fr; } }
  .card {
    position: relative; text-align: left; cursor: pointer;
    background: var(--capix-bg-elev); border: 1px solid var(--capix-border);
    border-radius: 16px; padding: 22px; font-family: inherit; color: var(--capix-fg);
    display: flex; flex-direction: column; gap: 8px;
    transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
  }
  .card:hover { border-color: var(--capix-border-strong); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0,0,0,0.35); }
  .card:focus-visible { outline: 2px solid var(--capix-cyan); outline-offset: 2px; }
  .card-icon {
    width: 44px; height: 44px; border-radius: 12px; display: inline-flex;
    align-items: center; justify-content: center; margin-bottom: 6px;
  }
  .card-icon.deploy { background: rgba(61,206,214,0.12); color: var(--capix-cyan); }
  .card-icon.chat { background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .card-icon.cloud { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .card-title { font-size: 16px; font-weight: 700; }
  .card-desc { font-size: 13px; color: var(--capix-muted); line-height: 1.5; flex: 1; }
  .card-cta { font-size: 13px; font-weight: 600; color: var(--capix-cyan); margin-top: 6px; }
  .card-progress { margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--capix-border); font-family: "JetBrains Mono", monospace; font-size: 12px; }
  .progress-text { color: var(--capix-green); }
  .progress-text.busy { color: var(--capix-amber); }
  .live-url { display: inline-block; margin-top: 6px; color: var(--capix-cyan); text-decoration: none; word-break: break-all; }
  .live-url:hover { text-decoration: underline; }

  .footer {
    position: relative; z-index: 2;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 18px 32px; border-top: 1px solid var(--capix-border); flex-wrap: wrap;
  }
  .footer-text { font-size: 12px; color: var(--capix-faint); }

  .toast {
    position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%);
    background: var(--capix-bg-elev); border: 1px solid var(--capix-border-strong);
    color: var(--capix-fg); padding: 12px 18px; border-radius: 10px; font-size: 13px;
    z-index: 50; box-shadow: 0 12px 40px rgba(0,0,0,0.4); max-width: 80vw;
  }
`;

const ONBOARDING_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function applyState(state) {
    const chip = $('balance-chip');
    const label = $('balance-label');
    const signedOut = $('hero-signedout');
    const signedIn = $('hero-signedin');
    if (state.configured) {
      signedOut.hidden = true;
      signedIn.hidden = false;
      chip.hidden = false;
      label.textContent = '$' + (state.balanceUsd || '1.00') + ' balance';
    } else {
      chip.hidden = true;
      signedOut.hidden = false;
      signedIn.hidden = true;
    }
  }

  function setDeployProgress(stage, url) {
    const wrap = $('deploy-progress');
    const text = $('deploy-text');
    const urlEl = $('deploy-url');
    const cta = $('deploy-cta');
    if (stage === 'idle') { wrap.hidden = true; cta.hidden = false; return; }
    wrap.hidden = false; cta.hidden = true;
    text.className = 'progress-text busy';
    if (stage === 'scaffolding') text.textContent = 'Scaffolding your app…';
    else if (stage === 'deploying') text.textContent = 'Opening deploy…';
    else if (stage === 'done') { text.className = 'progress-text'; text.textContent = 'Your app is ready — finish deploy to go live'; }
    if (url) { urlEl.hidden = false; urlEl.href = url; urlEl.textContent = url; } else { urlEl.hidden = true; }
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-cmd]') : null;
    if (!t) return;
    const cmd = t.dataset.cmd;
    if (cmd === 'signIn') toast('Opening secure sign-in…');
    vscode.postMessage({ type: cmd });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'state':
        applyState(msg);
        if (msg.deployStage) setDeployProgress(msg.deployStage, msg.deployUrl);
        break;
      case 'deployProgress':
        setDeployProgress(msg.stage, msg.url);
        break;
      case 'chatOpened':
        toast('Opened Capix Code — your test message is on its way.');
        break;
      case 'explored':
        toast('Opened the Capix Cloud dashboard.');
        break;
      case 'error':
        toast(esc(msg.message));
        break;
    }
  });

  vscode.postMessage({ type: 'refresh' });
`;
