/**
 * Web Control Panel — the operator surface for CapixIDE's web control.
 *
 * A singleton webview panel (`capix.webControl.openPanel`) with four tabs:
 *
 *     Browser | History | Inspector | Network
 *
 *   • Browser    live page preview (rendered SVG snapshot when captured,
 *                otherwise the extracted text / link / form view), a URL bar
 *                and one-click extract/screenshot actions
 *   • History    every recorded action with replay-from-here buttons
 *   • Inspector  all parsed elements; clicking a row shows full attributes
 *   • Network    every HTTP exchange with status, timing and size
 *
 * All actions execute through the shared {@link WebControlManager}; the
 * webview only renders state pushed from the host. No external scripts —
 * stays inside the strict CSP (script-src 'nonce-<nonce>'). Visuals follow
 * the @capix/ui-tokens dark palette used by the other Capix panels.
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { logger } from "./logger";
import type { NetworkEntry, WebAction, WebControlManager, WebElement, WebPageState } from "./webControl";

// ── Host ↔ webview protocol ─────────────────────────────────────────────────

interface PanelState {
  page: WebPageState | null;
  history: WebAction[];
  network: NetworkEntry[];
  /** Latest captured SVG snapshot, when one was taken this session. */
  screenshotSvg: string | null;
  /** Summary of the most recent action, shown as a status line. */
  lastResult: string;
  /** Element selected in the Inspector tab. */
  inspected: WebElement | null;
}

export class WebControlPanel {
  private static current: WebControlPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private screenshotSvg: string | null = null;
  private lastResult = "";
  private inspected: WebElement | null = null;
  private disposed = false;

  /** Create the panel, or reveal the existing one. */
  static createOrShow(extensionUri: vscode.Uri, manager: WebControlManager): WebControlPanel {
    if (WebControlPanel.current && !WebControlPanel.current.disposed) {
      WebControlPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      void WebControlPanel.current.pushState();
      return WebControlPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "capix.webControl.panel",
      "Capix Web Control",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    WebControlPanel.current = new WebControlPanel(panel, manager);
    return WebControlPanel.current;
  }

  /** Testing hook: reset the singleton. */
  static resetForTests(): void {
    WebControlPanel.current = null;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly manager: WebControlManager,
  ) {
    this.panel = panel;
    this.panel.webview.html = buildWebControlHtml(randomBytes(16).toString("base64"));
    this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (WebControlPanel.current === this) WebControlPanel.current = null;
    });
  }

  /** Serialize the manager state for the webview. */
  getState(): PanelState {
    return {
      page: this.manager.getPage(),
      history: this.manager.getHistory(),
      network: this.manager.getNetworkLog(),
      screenshotSvg: this.screenshotSvg,
      lastResult: this.lastResult,
      inspected: this.inspected,
    };
  }

  private async pushState(): Promise<void> {
    if (this.disposed) return;
    await this.panel.webview.postMessage({ type: "state", state: this.getState() });
  }

  private async run(summary: Promise<{ ok: boolean; summary: string; data?: unknown }>): Promise<void> {
    try {
      const result = await summary;
      this.lastResult = `${result.ok ? "OK" : "Failed"} — ${result.summary.split("\n")[0]}`;
      const shot = result.data as { svg?: string } | undefined;
      if (shot?.svg) this.screenshotSvg = shot.svg;
    } catch (err) {
      this.lastResult = `Error — ${err instanceof Error ? err.message : String(err)}`;
      logger.warn("WebControlPanel action failed", { error: String(err) });
    }
    await this.pushState();
  }

  private async handleMessage(msg: { type?: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "refresh":
        await this.pushState();
        return;
      case "navigate":
        await this.run(this.manager.open(String(msg.url ?? "")));
        return;
      case "click":
        await this.run(this.manager.click(String(msg.ref ?? "")));
        return;
      case "typeText":
        await this.run(this.manager.typeText(String(msg.ref ?? ""), String(msg.text ?? "")));
        return;
      case "extract":
        await this.run(this.manager.extract(String(msg.selector ?? "text")));
        return;
      case "screenshot":
        await this.run(this.manager.screenshot());
        return;
      case "research":
        await this.run(this.manager.research(String(msg.query ?? "")));
        return;
      case "docs":
        await this.run(this.manager.docsLookup(String(msg.topic ?? "")));
        return;
      case "inspect": {
        const result = await this.manager.inspect(String(msg.ref ?? ""));
        this.inspected = result.ok ? ((result.data as WebElement | undefined) ?? null) : null;
        this.lastResult = result.summary;
        await this.pushState();
        return;
      }
      case "replay": {
        const results = await this.manager.replay(
          typeof msg.actionId === "number" ? msg.actionId : undefined,
        );
        const ok = results.filter((r) => r.ok).length;
        this.lastResult = `Replayed ${results.length} action(s): ${ok} ok, ${results.length - ok} failed.`;
        await this.pushState();
        return;
      }
      case "clearHistory":
        this.manager.clearHistory();
        this.screenshotSvg = null;
        this.inspected = null;
        this.lastResult = "History cleared.";
        await this.pushState();
        return;
      default:
        logger.warn("WebControlPanel: unknown message", { type: String(msg.type) });
    }
  }
}

// ── HTML (pure, unit-testable) ──────────────────────────────────────────────

const PANEL_SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var state = { page: null, history: [], network: [], screenshotSvg: null, lastResult: "", inspected: null };
  var activeTab = "browser";

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function esc(s) { return String(s == null ? "" : s); }

  function post(msg) { vscode.postMessage(msg); }

  // ── Tabs ──────────────────────────────────────────────────────────────
  function activate(tab) {
    activeTab = tab;
    document.querySelectorAll(".wc-tab").forEach(function (b) {
      b.classList.toggle("wc-tab--active", b.dataset.tab === tab);
    });
    render();
  }

  // ── Renderers ─────────────────────────────────────────────────────────
  function renderStatus(root) {
    var bar = el("div", "wc-status", state.lastResult || "Ready.");
    root.appendChild(bar);
  }

  function renderBrowser(root) {
    var bar = el("div", "wc-urlbar");
    var input = el("input", "wc-input");
    input.placeholder = "https://example.com";
    input.id = "wc-url";
    var go = el("button", "wc-btn wc-btn--primary", "Open");
    go.addEventListener("click", function () { if (input.value.trim()) post({ type: "navigate", url: input.value.trim() }); });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && input.value.trim()) post({ type: "navigate", url: input.value.trim() }); });
    var shot = el("button", "wc-btn", "Screenshot");
    shot.addEventListener("click", function () { post({ type: "screenshot" }); });
    var extractBtn = el("button", "wc-btn", "Extract text");
    extractBtn.addEventListener("click", function () { post({ type: "extract", selector: "text" }); });
    bar.appendChild(input); bar.appendChild(go); bar.appendChild(shot); bar.appendChild(extractBtn);
    root.appendChild(bar);

    var page = state.page;
    if (!page) {
      root.appendChild(el("div", "wc-empty", "No page open. Enter a URL above or ask the assistant to use browser_open."));
      return;
    }
    var meta = el("div", "wc-meta",
      (page.title || "untitled") + " — " + page.finalUrl + " (HTTP " + page.status + ", " +
      page.elements.length + " elements, " + page.links.length + " links, " + page.forms.length + " forms)");
    root.appendChild(meta);

    if (state.screenshotSvg) {
      var shotWrap = el("div", "wc-preview");
      shotWrap.innerHTML = state.screenshotSvg;
      root.appendChild(shotWrap);
    }

    var text = el("pre", "wc-text", page.text ? page.text.slice(0, 4000) : "(no text content)");
    root.appendChild(text);

    if (page.links.length) {
      root.appendChild(el("h3", "wc-h", "Links"));
      var list = el("div", "wc-list");
      page.links.slice(0, 50).forEach(function (l) {
        var row = el("div", "wc-row");
        row.appendChild(el("span", "wc-ref", l.ref));
        var link = el("a", "wc-link", (l.text || l.href).slice(0, 80));
        link.href = "#";
        link.title = l.href;
        link.addEventListener("click", function (e) { e.preventDefault(); post({ type: "click", ref: l.ref }); });
        row.appendChild(link);
        list.appendChild(row);
      });
      root.appendChild(list);
    }

    if (page.forms.length) {
      root.appendChild(el("h3", "wc-h", "Forms"));
      page.forms.forEach(function (f) {
        var box = el("div", "wc-form");
        box.appendChild(el("div", "wc-form__head", f.ref + " — " + f.method + " " + (f.action || "(self)")));
        var inputs = page.elements.filter(function (e) { return e.formRef === f.ref && (e.tag === "input" || e.tag === "textarea" || e.tag === "select"); });
        inputs.forEach(function (inp) {
          var row = el("div", "wc-form__row");
          row.appendChild(el("label", "wc-form__label", (inp.attributes.name || inp.ref) + " (" + inp.ref + ")"));
          var field = el("input", "wc-input wc-input--small");
          field.value = inp.attributes.value || "";
          field.addEventListener("change", function () { post({ type: "typeText", ref: inp.ref, text: field.value }); });
          row.appendChild(field);
          box.appendChild(row);
        });
        var submit = page.elements.find(function (e) {
          return e.formRef === f.ref && ((e.tag === "button" && (e.attributes.type || "submit").toLowerCase() === "submit") ||
            (e.tag === "input" && ["submit", "image"].indexOf((e.attributes.type || "").toLowerCase()) >= 0));
        });
        if (submit) {
          var btn = el("button", "wc-btn wc-btn--primary", "Submit (" + submit.ref + ")");
          btn.addEventListener("click", function () { post({ type: "click", ref: submit.ref }); });
          box.appendChild(btn);
        }
        root.appendChild(box);
      });
    }
  }

  function renderHistory(root) {
    var head = el("div", "wc-toolbar");
    var clear = el("button", "wc-btn", "Clear history");
    clear.addEventListener("click", function () { post({ type: "clearHistory" }); });
    head.appendChild(clear);
    root.appendChild(head);
    if (!state.history.length) {
      root.appendChild(el("div", "wc-empty", "No actions recorded yet."));
      return;
    }
    state.history.slice().reverse().forEach(function (a) {
      var row = el("div", "wc-row wc-row--history" + (a.ok ? "" : " wc-row--failed"));
      row.appendChild(el("span", "wc-ref", "#" + a.id));
      row.appendChild(el("span", "wc-tool", a.tool));
      row.appendChild(el("span", "wc-summary", a.summary));
      var replay = el("button", "wc-btn wc-btn--small", "Replay");
      replay.title = "Replay from this action";
      replay.addEventListener("click", function () { post({ type: "replay", actionId: a.id }); });
      row.appendChild(replay);
      root.appendChild(row);
    });
  }

  function renderInspector(root) {
    var page = state.page;
    if (!page) {
      root.appendChild(el("div", "wc-empty", "Open a page to inspect its elements."));
      return;
    }
    if (state.inspected) {
      var detail = el("div", "wc-inspect");
      detail.appendChild(el("div", "wc-form__head", "<" + state.inspected.tag + "> " + state.inspected.ref +
        (state.inspected.formRef ? " (form " + state.inspected.formRef + ")" : "")));
      var attrs = Object.keys(state.inspected.attributes).map(function (k) {
        return k + '="' + state.inspected.attributes[k] + '"';
      }).join("\n");
      detail.appendChild(el("pre", "wc-text", (attrs || "(no attributes)") + "\n\n" + (state.inspected.text || "(no text)")));
      root.appendChild(detail);
    }
    var list = el("div", "wc-list");
    page.elements.slice(0, 300).forEach(function (e) {
      var row = el("div", "wc-row wc-row--clickable");
      row.appendChild(el("span", "wc-ref", e.ref));
      row.appendChild(el("span", "wc-tool", "<" + e.tag + ">"));
      row.appendChild(el("span", "wc-summary", (e.text || Object.keys(e.attributes).map(function (k) { return k + "=" + e.attributes[k]; }).join(" ")).slice(0, 100)));
      row.addEventListener("click", function () { post({ type: "inspect", ref: e.ref }); });
      list.appendChild(row);
    });
    root.appendChild(list);
  }

  function renderNetwork(root) {
    if (!state.network.length) {
      root.appendChild(el("div", "wc-empty", "No network activity yet."));
      return;
    }
    var table = el("table", "wc-table");
    var head = el("tr");
    ["#", "Method", "URL", "Status", "Time", "Bytes"].forEach(function (h) { head.appendChild(el("th", "", h)); });
    table.appendChild(head);
    state.network.slice().reverse().forEach(function (n) {
      var tr = el("tr", n.status >= 400 ? "wc-row--failed" : "");
      tr.appendChild(el("td", "", n.id));
      tr.appendChild(el("td", "", n.method));
      var urlTd = el("td", "wc-url", n.url);
      urlTd.title = n.url;
      tr.appendChild(urlTd);
      tr.appendChild(el("td", "", n.status));
      tr.appendChild(el("td", "", n.durationMs + "ms"));
      tr.appendChild(el("td", "", n.bytes));
      table.appendChild(tr);
    });
    root.appendChild(table);
  }

  function render() {
    var root = document.getElementById("wc-root");
    root.textContent = "";
    renderStatus(root);
    if (activeTab === "browser") renderBrowser(root);
    else if (activeTab === "history") renderHistory(root);
    else if (activeTab === "inspector") renderInspector(root);
    else renderNetwork(root);
  }

  document.querySelectorAll(".wc-tab").forEach(function (b) {
    b.addEventListener("click", function () { activate(b.dataset.tab); });
  });

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (msg && msg.type === "state") {
      state = msg.state;
      render();
    }
  });

  post({ type: "ready" });
})();
`;

const PANEL_STYLE = `
  body { background: #0a0e14; color: #c9d1d9; font-family: var(--vscode-font-family, sans-serif); margin: 0; padding: 0 16px 24px; }
  .wc-tabs { display: flex; gap: 4px; padding: 10px 0; border-bottom: 1px solid #1c2530; position: sticky; top: 0; background: #0a0e14; }
  .wc-tab { background: none; border: none; color: #7d8a99; padding: 6px 12px; cursor: pointer; font-size: 13px; border-radius: 4px; }
  .wc-tab--active { color: #3DCED6; background: #11161f; }
  .wc-status { margin: 12px 0; padding: 8px 10px; background: #11161f; border-left: 3px solid #3DCED6; font-size: 12px; border-radius: 3px; word-break: break-word; }
  .wc-urlbar { display: flex; gap: 6px; margin: 12px 0; }
  .wc-input { flex: 1; background: #11161f; border: 1px solid #1c2530; color: #c9d1d9; padding: 6px 10px; border-radius: 4px; font-size: 13px; }
  .wc-input--small { flex: 0 1 260px; padding: 4px 8px; font-size: 12px; }
  .wc-btn { background: #11161f; border: 1px solid #1c2530; color: #c9d1d9; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .wc-btn:hover { border-color: #3DCED6; }
  .wc-btn--primary { background: #3DCED6; color: #0a0e14; border-color: #3DCED6; font-weight: 600; }
  .wc-btn--small { padding: 2px 8px; font-size: 11px; }
  .wc-meta { color: #7d8a99; font-size: 12px; margin: 8px 0; word-break: break-all; }
  .wc-preview { margin: 10px 0; border: 1px solid #1c2530; border-radius: 4px; overflow: auto; max-height: 480px; }
  .wc-preview svg { display: block; max-width: 100%; height: auto; }
  .wc-text { background: #11161f; padding: 10px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
  .wc-h { color: #3DCED6; font-size: 13px; margin: 16px 0 6px; }
  .wc-list { display: flex; flex-direction: column; gap: 2px; }
  .wc-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 3px; font-size: 12px; }
  .wc-row--clickable { cursor: pointer; }
  .wc-row--clickable:hover, .wc-row--history:hover { background: #11161f; }
  .wc-row--failed { border-left: 2px solid #ff5252; }
  .wc-ref { color: #FFAE00; font-family: monospace; min-width: 40px; }
  .wc-tool { color: #3DCED6; font-family: monospace; white-space: nowrap; }
  .wc-summary { color: #7d8a99; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .wc-link { color: #3DCED6; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wc-link:hover { text-decoration: underline; }
  .wc-form { background: #11161f; border: 1px solid #1c2530; border-radius: 4px; padding: 10px; margin: 8px 0; }
  .wc-form__head { color: #14F195; font-size: 12px; font-family: monospace; margin-bottom: 8px; }
  .wc-form__row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .wc-form__label { color: #7d8a99; font-size: 12px; min-width: 180px; }
  .wc-inspect { margin: 10px 0; }
  .wc-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
  .wc-table th { text-align: left; color: #7d8a99; padding: 4px 8px; border-bottom: 1px solid #1c2530; }
  .wc-table td { padding: 4px 8px; border-bottom: 1px solid #11161f; }
  .wc-url { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wc-empty { color: #7d8a99; padding: 24px 0; text-align: center; font-size: 13px; }
  .wc-toolbar { display: flex; justify-content: flex-end; margin: 10px 0; }
`;

/** Build the panel HTML with a strict nonce-scoped CSP. */
export function buildWebControlHtml(nonce: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Capix Web Control</title>
<style>${PANEL_STYLE}</style>
</head>
<body>
<div class="wc-tabs">
  <button class="wc-tab wc-tab--active" data-tab="browser">Browser</button>
  <button class="wc-tab" data-tab="history">History</button>
  <button class="wc-tab" data-tab="inspector">Inspector</button>
  <button class="wc-tab" data-tab="network">Network</button>
</div>
<div id="wc-root"></div>
<script nonce="${nonce}">${PANEL_SCRIPT}</script>
</body>
</html>`;
}
