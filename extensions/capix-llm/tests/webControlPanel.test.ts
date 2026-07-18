import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreateWebviewPanel, mockAppendLine } = vi.hoisted(() => ({
  mockCreateWebviewPanel: vi.fn(),
  mockAppendLine: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: mockCreateWebviewPanel,
    createOutputChannel: vi.fn(() => ({ appendLine: mockAppendLine })),
    showErrorMessage: vi.fn(),
  },
  ViewColumn: { Beside: 2, One: 1 },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { WebControlPanel, buildWebControlHtml } from "../src/webControlPanel";
import { WebControlManager, type HttpResponse } from "../src/webControl";

const PAGE_HTML = `<html><head><title>Panel Page</title></head><body>
<h1>Panel</h1><a href="/two">Two</a></body></html>`;

function makeManager() {
  return new WebControlManager({
    transport: async (req): Promise<HttpResponse> => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html" },
      body: PAGE_HTML,
      url: req.url,
    }),
  });
}

interface MockPanel {
  webview: {
    html: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  };
  reveal: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function setupPanel() {
  const listeners: Array<(msg: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const panel: MockPanel = {
    webview: {
      html: "",
      onDidReceiveMessage: vi.fn((cb: (msg: unknown) => void) => listeners.push(cb)),
      postMessage: vi.fn(async () => true),
    },
    reveal: vi.fn(),
    onDidDispose: vi.fn((cb: () => void) => disposeListeners.push(cb)),
    dispose: vi.fn(() => disposeListeners.forEach((cb) => cb())),
  };
  mockCreateWebviewPanel.mockReturnValue(panel);
  const send = async (msg: unknown) => {
    for (const cb of listeners) cb(msg);
    // handleMessage is async behind a fire-and-forget wrapper; let the
    // microtask queue drain so pushed state is observable.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { panel, send };
}

const EXT_URI = { fsPath: "/ext" } as never;

describe("buildWebControlHtml", () => {
  it("scopes scripts to the supplied nonce under a strict CSP", () => {
    const html = buildWebControlHtml("NONCE123");
    expect(html).toContain(`script-src 'nonce-NONCE123'`);
    expect(html).toContain(`<script nonce="NONCE123">`);
    expect(html).toContain("default-src 'none'");
  });

  it("renders the four tabs", () => {
    const html = buildWebControlHtml("n");
    for (const tab of ["Browser", "History", "Inspector", "Network"]) {
      expect(html).toContain(tab);
    }
  });
});

describe("WebControlPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    WebControlPanel.resetForTests();
  });

  it("creates the webview panel once and reveals it on subsequent opens", () => {
    const { panel } = setupPanel();
    const manager = makeManager();

    const first = WebControlPanel.createOrShow(EXT_URI, manager);
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    expect(mockCreateWebviewPanel).toHaveBeenCalledWith(
      "capix.webControl.panel",
      "Capix Web Control",
      2,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(panel.webview.html).toContain("wc-root");

    const second = WebControlPanel.createOrShow(EXT_URI, manager);
    expect(second).toBe(first);
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledWith(2);
  });

  it("creates a fresh panel after the previous one is disposed", () => {
    const { panel } = setupPanel();
    WebControlPanel.createOrShow(EXT_URI, makeManager());
    panel.dispose();
    setupPanel();
    WebControlPanel.createOrShow(EXT_URI, makeManager());
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it("pushes full state on ready", async () => {
    const { panel, send } = setupPanel();
    const manager = makeManager();
    WebControlPanel.createOrShow(EXT_URI, manager);

    await send({ type: "ready" });
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "state",
      state: expect.objectContaining({ page: null, history: [], network: [], screenshotSvg: null }),
    });
  });

  it("navigates through the manager and pushes the loaded page", async () => {
    const { panel, send } = setupPanel();
    const manager = makeManager();
    WebControlPanel.createOrShow(EXT_URI, manager);

    await send({ type: "navigate", url: "https://example.com/" });
    expect(manager.getPage()?.title).toBe("Panel Page");

    const last = panel.webview.postMessage.mock.calls.at(-1)![0] as {
      type: string;
      state: { page: { title: string } | null; history: unknown[]; lastResult: string };
    };
    expect(last.type).toBe("state");
    expect(last.state.page?.title).toBe("Panel Page");
    expect(last.state.history).toHaveLength(1);
    expect(last.state.lastResult).toContain("OK");
  });

  it("captures screenshots and keeps the SVG in pushed state", async () => {
    const { panel, send } = setupPanel();
    WebControlPanel.createOrShow(EXT_URI, makeManager());

    await send({ type: "navigate", url: "https://example.com/" });
    await send({ type: "screenshot" });

    const last = panel.webview.postMessage.mock.calls.at(-1)![0] as {
      state: { screenshotSvg: string | null };
    };
    expect(last.state.screenshotSvg).toContain("<svg");
    expect(last.state.screenshotSvg).toContain("Panel Page");
  });

  it("surfaces action failures in the status line instead of throwing", async () => {
    const { panel, send } = setupPanel();
    WebControlPanel.createOrShow(EXT_URI, makeManager());

    await send({ type: "click", ref: "e1" }); // no page open
    const last = panel.webview.postMessage.mock.calls.at(-1)![0] as {
      state: { lastResult: string };
    };
    expect(last.state.lastResult).toContain("Failed");
  });

  it("handles inspect, replay and clearHistory messages", async () => {
    const { panel, send } = setupPanel();
    const manager = makeManager();
    WebControlPanel.createOrShow(EXT_URI, manager);

    await send({ type: "navigate", url: "https://example.com/" });
    const linkRef = manager.getPage()!.links[0].ref;

    await send({ type: "inspect", ref: linkRef });
    let last = panel.webview.postMessage.mock.calls.at(-1)![0] as {
      state: { inspected: { ref: string } | null };
    };
    expect(last.state.inspected?.ref).toBe(linkRef);

    await send({ type: "replay" });
    last = panel.webview.postMessage.mock.calls.at(-1)![0] as never;
    expect((last as { state: { lastResult: string } }).state.lastResult).toContain("Replayed");

    await send({ type: "clearHistory" });
    expect(manager.getHistory()).toHaveLength(0);
    last = panel.webview.postMessage.mock.calls.at(-1)![0] as never;
    expect((last as { state: { screenshotSvg: string | null } }).state.screenshotSvg).toBeNull();
  });

  it("ignores unknown message types", async () => {
    const { panel, send } = setupPanel();
    WebControlPanel.createOrShow(EXT_URI, makeManager());
    await send({ type: "nonsense" });
    expect(panel.webview.postMessage).not.toHaveBeenCalled();
  });
});
