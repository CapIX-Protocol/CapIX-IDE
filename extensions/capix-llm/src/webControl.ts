/**
 * Web Control — the browser-automation core behind CapixIDE's web tools.
 *
 * The extension host has no embedded browser and the extension ships no
 * headless-browser dependency, so this manager drives the web over HTTP: it
 * fetches pages through a pluggable transport (global `fetch` by default),
 * parses the returned HTML into a lightweight element model, and executes
 * navigation, form, extraction and inspection actions against that model.
 *
 * Capabilities:
 *   • open URLs, follow links, fill and submit forms (GET/POST)
 *   • extract page content by simple selector (tag, .class, #id, [attr])
 *   • capture a "screenshot": a rendered SVG snapshot of the page plus an
 *     accessibility-tree-style text summary for the assistant to analyse
 *   • research queries (DuckDuckGo HTML) and documentation lookup (MDN)
 *   • raw API testing with timing and response capture
 *
 * Every action is recorded in a capped history (replayable from any point)
 * and every HTTP exchange lands in a capped network log. The manager is
 * deliberately vscode-free so it is unit-testable in isolation; the panel
 * (`webControlPanel.ts`) and the agent tools (`browserTools.ts`) sit on top.
 */

// ── Caps — web payloads must stay small and high-signal. ────────────────────
const MAX_HTML_CHARS = 500_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_ELEMENT_TEXT_CHARS = 2_000;
const MAX_ELEMENTS = 500;
const MAX_BODY_CHARS = 20_000;
const MAX_HISTORY = 200;
const MAX_NETWORK_LOG = 100;
const MAX_RESEARCH_RESULTS = 10;
const MAX_SCREENSHOT_LINES = 38;
const SCREENSHOT_LINE_WIDTH = 88;
const DEFAULT_TIMEOUT_MS = 20_000;

// ── Transport ───────────────────────────────────────────────────────────────

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: string;
  /** Final URL after redirects, when the transport reports it. */
  url?: string;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

const defaultTransport: HttpTransport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "follow",
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, statusText: res.statusText, headers, body: await res.text(), url: res.url };
  } finally {
    clearTimeout(timer);
  }
};

// ── Element model ───────────────────────────────────────────────────────────

export interface WebElement {
  /** Stable within a page load: "e1", "e2", … in document order. */
  ref: string;
  tag: string;
  attributes: Record<string, string>;
  /** Descendant text content, capped. */
  text: string;
  /** Ref of the owning <form>, when the element sits inside one. */
  formRef?: string;
}

export interface WebForm {
  ref: string;
  action: string;
  method: "GET" | "POST";
  fields: Record<string, string>;
}

export interface WebLink {
  ref: string;
  text: string;
  href: string;
}

export interface WebPageState {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  elements: WebElement[];
  links: WebLink[];
  forms: WebForm[];
  fetchedAt: string;
}

export interface NetworkEntry {
  id: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  bytes: number;
  at: string;
}

export interface WebAction {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  at: string;
}

export interface WebActionResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export interface ResearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DocResult {
  title: string;
  url: string;
  summary: string;
}

export interface ScreenshotResult {
  /** Rendered SVG snapshot of the current page. */
  svg: string;
  /** Accessibility-tree-style text summary for assistant analysis. */
  summary: string;
  width: number;
  height: number;
}

export interface ApiTestResult {
  status: number;
  statusText?: string;
  durationMs: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

// ── HTML parsing (best-effort, dependency-free) ─────────────────────────────

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

interface OpenElement {
  ref: string;
  tag: string;
  attributes: Record<string, string>;
  textParts: string[];
  textLength: number;
  formRef?: string;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cap(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

interface ParsedPage {
  title: string;
  text: string;
  elements: WebElement[];
  links: WebLink[];
  forms: WebForm[];
}

function parsePage(html: string): ParsedPage {
  const source = cap(html, MAX_HTML_CHARS).text;

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const title = titleMatch ? collapseWhitespace(decodeEntities(titleMatch[1])) : "";

  // Drop non-content blocks before tokenising.
  const body = source
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const elements: WebElement[] = [];
  const stack: OpenElement[] = [];
  const pageTextParts: string[] = [];
  let pageTextLength = 0;
  let nextRef = 1;

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let lastIndex = 0;

  const pushText = (chunk: string): void => {
    const decoded = decodeEntities(chunk);
    if (!decoded.trim()) return;
    if (pageTextLength < MAX_TEXT_CHARS) {
      pageTextParts.push(decoded);
      pageTextLength += decoded.length;
    }
    for (const open of stack) {
      if (open.textLength < MAX_ELEMENT_TEXT_CHARS) {
        open.textParts.push(decoded);
        open.textLength += decoded.length;
      }
    }
  };

  const closeElement = (tag: string): void => {
    // Lenient close: pop until the matching tag (or the stack drains).
    for (let i = stack.length - 1; i >= 0; i--) {
      const open = stack[i];
      if (open.tag !== tag) continue;
      stack.length = i;
      if (elements.length < MAX_ELEMENTS) {
        elements.push({
          ref: open.ref,
          tag: open.tag,
          attributes: open.attributes,
          text: collapseWhitespace(open.textParts.join(" ")),
          formRef: open.formRef,
        });
      }
      return;
    }
  };

  while ((m = TAG_RE.exec(body))) {
    pushText(body.slice(lastIndex, m.index));
    lastIndex = TAG_RE.lastIndex;

    const isClose = m[1] === "/";
    const tag = m[2].toLowerCase();
    const selfClosing = m[4] === "/";

    if (isClose) {
      closeElement(tag);
      continue;
    }

    const attributes = parseAttributes(m[3] ?? "");
    const parentForm = [...stack].reverse().find((e) => e.tag === "form");
    const open: OpenElement = {
      ref: `e${nextRef++}`,
      tag,
      attributes,
      textParts: [],
      textLength: 0,
      formRef: tag === "form" ? undefined : parentForm?.ref,
    };
    stack.push(open);
    if (VOID_TAGS.has(tag) || selfClosing) closeElement(tag);
  }
  pushText(body.slice(lastIndex));
  // Flush anything left open at EOF.
  while (stack.length) closeElement(stack[stack.length - 1].tag);

  // Elements were recorded on close (children before parents) — restore
  // document order by ref number.
  elements.sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));

  const links: WebLink[] = elements
    .filter((e) => e.tag === "a" && e.attributes.href)
    .map((e) => ({ ref: e.ref, text: e.text || e.attributes.href, href: e.attributes.href }));

  const forms: WebForm[] = elements
    .filter((e) => e.tag === "form")
    .map((form) => {
      const fields: Record<string, string> = {};
      for (const el of elements) {
        if (el.formRef !== form.ref) continue;
        if (el.tag !== "input" && el.tag !== "textarea" && el.tag !== "select") continue;
        const name = el.attributes.name;
        if (!name) continue;
        fields[name] = el.attributes.value ?? "";
      }
      return {
        ref: form.ref,
        action: form.attributes.action ?? "",
        method: (form.attributes.method ?? "get").toUpperCase() === "POST" ? "POST" : "GET",
        fields,
      } as WebForm;
    });

  return { title, text: collapseWhitespace(pageTextParts.join(" ")), elements, links, forms };
}

// ── Simple selector matching (tag / .class / #id / tag.class / [attr=v]) ────

interface SimpleSelector {
  tag?: string;
  id?: string;
  className?: string;
  attr?: { name: string; value?: string };
}

function parseSelector(selector: string): SimpleSelector | null {
  const s = selector.trim();
  if (!s || /[\s>+~]/.test(s)) return null; // combinators unsupported by design
  const out: SimpleSelector = {};
  const attrMatch = /\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\]/.exec(s);
  let rest = s;
  if (attrMatch) {
    out.attr = { name: attrMatch[1].toLowerCase(), value: attrMatch[2] };
    rest = rest.replace(attrMatch[0], "");
  }
  const idMatch = /#([A-Za-z0-9_-]+)/.exec(rest);
  if (idMatch) out.id = idMatch[1];
  const classMatch = /\.([A-Za-z0-9_-]+)/.exec(rest);
  if (classMatch) out.className = classMatch[1];
  const tagMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
  if (tagMatch) out.tag = tagMatch[0].toLowerCase();
  if (!out.tag && !out.id && !out.className && !out.attr) return null;
  return out;
}

function matchesSelector(el: WebElement, sel: SimpleSelector): boolean {
  if (sel.tag && el.tag !== sel.tag) return false;
  if (sel.id && el.attributes.id !== sel.id) return false;
  if (sel.className) {
    const classes = (el.attributes.class ?? "").split(/\s+/);
    if (!classes.includes(sel.className)) return false;
  }
  if (sel.attr) {
    if (!(sel.attr.name in el.attributes)) return false;
    if (sel.attr.value !== undefined && el.attributes[sel.attr.name] !== sel.attr.value) return false;
  }
  return true;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export interface WebControlOptions {
  /** Injectable HTTP transport (defaults to global fetch). */
  transport?: HttpTransport;
}

export class WebControlManager {
  private readonly transport: HttpTransport;
  private page: WebPageState | null = null;
  /** Raw HTML of the current page, kept for screenshots/inspection. */
  private pageHtml = "";
  /** Live form field values (typed input overrides parsed defaults). */
  private formState = new Map<string, Record<string, string>>();
  private readonly actions: WebAction[] = [];
  private readonly network: NetworkEntry[] = [];
  private nextActionId = 1;
  private nextNetworkId = 1;
  private replaying = false;

  constructor(options: WebControlOptions = {}) {
    this.transport = options.transport ?? defaultTransport;
  }

  // ── State accessors ──────────────────────────────────────────────────────

  getPage(): WebPageState | null {
    return this.page;
  }

  getHistory(): WebAction[] {
    return [...this.actions];
  }

  getNetworkLog(): NetworkEntry[] {
    return [...this.network];
  }

  clearHistory(): void {
    this.actions.length = 0;
    this.network.length = 0;
  }

  /** Compact state summary injected into assistant context for web tasks. */
  describeState(): string {
    if (!this.page) return "No page is currently open in web control.";
    const recent = this.actions.slice(-5).map((a) => `${a.tool}(${a.ok ? "ok" : "failed"})`).join(", ");
    return [
      `Web control page: ${this.page.title || "(untitled)"} — ${this.page.finalUrl} (HTTP ${this.page.status})`,
      `${this.page.elements.length} elements, ${this.page.links.length} links, ${this.page.forms.length} forms.`,
      recent ? `Recent actions: ${recent}` : "No actions yet.",
    ].join("\n");
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  /** Navigate to a URL and parse the returned page. */
  async open(url: string): Promise<WebActionResult> {
    return this.record("browser_open", { url }, () => this.doOpen(url));
  }

  /** Click an element: follows links, submits forms for submit buttons. */
  async click(ref: string): Promise<WebActionResult> {
    return this.record("browser_click", { ref }, () => this.doClick(ref));
  }

  /** Set the value of an input/textarea/select (by element ref or field name). */
  async typeText(ref: string, text: string): Promise<WebActionResult> {
    return this.record("browser_type", { ref, text }, () => this.doType(ref, text));
  }

  /** Extract content: "text", "title", "links", or a simple CSS selector. */
  async extract(selector: string): Promise<WebActionResult> {
    return this.record("browser_extract", { selector }, () => this.doExtract(selector));
  }

  /** Render an SVG snapshot of the current page plus a text summary. */
  async screenshot(): Promise<WebActionResult> {
    return this.record("browser_screenshot", {}, () => this.doScreenshot());
  }

  /** Inspect one element: full attributes, text, owning form. */
  async inspect(ref: string): Promise<WebActionResult> {
    return this.record("browser_inspect", { ref }, () => {
      const el = this.requireElement(ref);
      if (!el) return { ok: false, summary: `No element with ref ${ref} on the current page.` };
      return { ok: true, summary: `<${el.tag}> ${el.ref}: ${el.text.slice(0, 120) || "(no text)"}`, data: el };
    });
  }

  /** Web research via DuckDuckGo's HTML endpoint. */
  async research(query: string): Promise<WebActionResult> {
    return this.record("research_query", { query }, () => this.doResearch(query));
  }

  /** Documentation lookup (MDN first, research fallback). */
  async docsLookup(topic: string): Promise<WebActionResult> {
    return this.record("docs_lookup", { topic }, () => this.doDocsLookup(topic));
  }

  /** Fire a raw HTTP request and capture the response for inspection. */
  async apiTest(req: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<WebActionResult> {
    return this.record("api_test", { ...req, body: req.body ? "(body)" : undefined }, () => this.doApiTest(req));
  }

  /**
   * Replay recorded actions from `fromActionId` (defaults to the first
   * action). The page state is reset first; replayed actions do not append
   * new history entries.
   */
  async replay(fromActionId?: number): Promise<WebActionResult[]> {
    if (this.replaying) return [{ ok: false, summary: "Replay already in progress." }];
    const startIndex = fromActionId === undefined
      ? 0
      : this.actions.findIndex((a) => a.id === fromActionId);
    if (startIndex < 0) return [{ ok: false, summary: `No action with id ${fromActionId}.` }];

    const queue = this.actions.slice(startIndex);
    this.page = null;
    this.pageHtml = "";
    this.formState.clear();
    this.replaying = true;
    const results: WebActionResult[] = [];
    try {
      for (const action of queue) {
        results.push(await this.dispatch(action.tool, action.args));
      }
    } finally {
      this.replaying = false;
    }
    return results;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async record(
    tool: string,
    args: Record<string, unknown>,
    run: () => Promise<WebActionResult> | WebActionResult,
  ): Promise<WebActionResult> {
    const result = await run();
    if (!this.replaying) {
      this.actions.push({
        id: this.nextActionId++,
        tool,
        args,
        ok: result.ok,
        summary: result.summary.slice(0, 300),
        at: new Date().toISOString(),
      });
      if (this.actions.length > MAX_HISTORY) this.actions.shift();
    }
    return result;
  }

  /** Re-dispatch a recorded action during replay (no history writes). */
  private dispatch(tool: string, args: Record<string, unknown>): Promise<WebActionResult> {
    switch (tool) {
      case "browser_open": return this.doOpen(String(args.url ?? ""));
      case "browser_click": return this.doClick(String(args.ref ?? ""));
      case "browser_type": return this.doType(String(args.ref ?? ""), String(args.text ?? ""));
      case "browser_extract": return this.doExtract(String(args.selector ?? ""));
      case "browser_screenshot": return this.doScreenshot();
      case "research_query": return this.doResearch(String(args.query ?? ""));
      case "docs_lookup": return this.doDocsLookup(String(args.topic ?? ""));
      case "api_test":
        return this.doApiTest({
          url: String(args.url ?? ""),
          method: args.method ? String(args.method) : undefined,
          headers: args.headers as Record<string, string> | undefined,
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        });
      default:
        return Promise.resolve({ ok: false, summary: `Action ${tool} is not replayable.` });
    }
  }

  private async request(req: HttpRequest): Promise<{ res: HttpResponse; durationMs: number }> {
    const started = Date.now();
    const res = await this.transport(req);
    const durationMs = Date.now() - started;
    this.network.push({
      id: this.nextNetworkId++,
      method: req.method.toUpperCase(),
      url: req.url,
      status: res.status,
      durationMs,
      bytes: res.body.length,
      at: new Date().toISOString(),
    });
    if (this.network.length > MAX_NETWORK_LOG) this.network.shift();
    return { res, durationMs };
  }

  private assertHttpUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${parsed.protocol} (http/https only)`);
    }
  }

  private resolveUrl(href: string): string {
    if (!this.page) return href;
    try {
      return new URL(href, this.page.finalUrl).toString();
    } catch {
      return href;
    }
  }

  private requireElement(ref: string): WebElement | null {
    return this.page?.elements.find((e) => e.ref === ref) ?? null;
  }

  private async doOpen(url: string): Promise<WebActionResult> {
    this.assertHttpUrl(url);
    const { res } = await this.request({ method: "GET", url });
    const contentType = res.headers["content-type"] ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType) && !res.body.trimStart().startsWith("<")) {
      const bodyCap = cap(res.body, MAX_BODY_CHARS);
      this.page = null;
      this.pageHtml = "";
      return {
        ok: res.status >= 200 && res.status < 400,
        summary: `HTTP ${res.status} ${url} — non-HTML response (${contentType || "unknown type"})`,
        data: { status: res.status, contentType, body: bodyCap.text, truncated: bodyCap.truncated },
      };
    }
    const parsed = parsePage(res.body);
    this.pageHtml = cap(res.body, MAX_HTML_CHARS).text;
    this.page = {
      url,
      finalUrl: res.url || url,
      status: res.status,
      contentType,
      title: parsed.title,
      text: parsed.text,
      elements: parsed.elements,
      links: parsed.links,
      forms: parsed.forms,
      fetchedAt: new Date().toISOString(),
    };
    this.formState.clear();
    for (const form of parsed.forms) this.formState.set(form.ref, { ...form.fields });
    return {
      ok: res.status >= 200 && res.status < 400,
      summary: `Opened ${this.page.finalUrl} — "${parsed.title || "untitled"}" (HTTP ${res.status}, ${parsed.links.length} links, ${parsed.forms.length} forms)`,
      data: this.page,
    };
  }

  private async doClick(ref: string): Promise<WebActionResult> {
    if (!this.page) return { ok: false, summary: "No page is open — call browser_open first." };
    const el = this.requireElement(ref);
    if (!el) return { ok: false, summary: `No element with ref ${ref} on the current page.` };

    if (el.tag === "a" && el.attributes.href) {
      const target = this.resolveUrl(el.attributes.href);
      const result = await this.doOpen(target);
      return { ...result, summary: `Clicked ${ref} → ${result.summary}` };
    }

    const isSubmit =
      el.tag === "button" && (el.attributes.type ?? "submit").toLowerCase() === "submit" ||
      el.tag === "input" && ["submit", "image"].includes((el.attributes.type ?? "").toLowerCase());
    if (isSubmit && el.formRef) {
      return this.submitForm(el.formRef);
    }

    return {
      ok: false,
      summary: `Element ${ref} (<${el.tag}>) is not actionable — only links and submit buttons can be clicked.`,
    };
  }

  private async doType(ref: string, text: string): Promise<WebActionResult> {
    if (!this.page) return { ok: false, summary: "No page is open — call browser_open first." };
    const el = this.requireElement(ref);
    if (!el) return { ok: false, summary: `No element with ref ${ref} on the current page.` };
    if (el.tag !== "input" && el.tag !== "textarea" && el.tag !== "select") {
      return { ok: false, summary: `Element ${ref} (<${el.tag}>) is not a text field.` };
    }
    const name = el.attributes.name;
    if (!name) return { ok: false, summary: `Element ${ref} has no name attribute; it cannot carry a value.` };
    if (el.formRef) {
      const state = this.formState.get(el.formRef) ?? {};
      state[name] = text;
      this.formState.set(el.formRef, state);
      return { ok: true, summary: `Set ${name} = "${text.slice(0, 60)}" in form ${el.formRef}.` };
    }
    return { ok: true, summary: `Set ${name} = "${text.slice(0, 60)}" (no enclosing form).` };
  }

  private async submitForm(formRef: string): Promise<WebActionResult> {
    if (!this.page) return { ok: false, summary: "No page is open." };
    const form = this.page.forms.find((f) => f.ref === formRef);
    if (!form) return { ok: false, summary: `No form with ref ${formRef} on the current page.` };
    const values = this.formState.get(formRef) ?? form.fields;
    const params = new URLSearchParams(values);
    const base = form.action ? this.resolveUrl(form.action) : this.page.finalUrl;
    this.assertHttpUrl(base);

    if (form.method === "GET") {
      const sep = base.includes("?") ? "&" : "?";
      const target = params.size ? `${base}${sep}${params.toString()}` : base;
      const result = await this.doOpen(target);
      return { ...result, summary: `Submitted form ${formRef} (GET) → ${result.summary}` };
    }
    const { res } = await this.request({
      method: "POST",
      url: base,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const contentType = res.headers["content-type"] ?? "";
    if (/text\/html/i.test(contentType)) {
      // Reuse the open path to reparse the response page.
      const parsed = parsePage(res.body);
      this.pageHtml = cap(res.body, MAX_HTML_CHARS).text;
      this.page = {
        url: base,
        finalUrl: res.url || base,
        status: res.status,
        contentType,
        title: parsed.title,
        text: parsed.text,
        elements: parsed.elements,
        links: parsed.links,
        forms: parsed.forms,
        fetchedAt: new Date().toISOString(),
      };
      this.formState.clear();
      for (const f of parsed.forms) this.formState.set(f.ref, { ...f.fields });
    }
    return {
      ok: res.status >= 200 && res.status < 400,
      summary: `Submitted form ${formRef} (POST ${base}) — HTTP ${res.status}`,
      data: { status: res.status, contentType },
    };
  }

  private async doExtract(selector: string): Promise<WebActionResult> {
    if (!this.page) return { ok: false, summary: "No page is open — call browser_open first." };
    const sel = selector.trim();
    if (sel === "text") {
      return { ok: true, summary: `Extracted page text (${this.page.text.length} chars).`, data: this.page.text };
    }
    if (sel === "title") {
      return { ok: true, summary: `Title: ${this.page.title}`, data: this.page.title };
    }
    if (sel === "links") {
      return { ok: true, summary: `${this.page.links.length} links.`, data: this.page.links };
    }
    const parsed = parseSelector(sel);
    if (!parsed) {
      return { ok: false, summary: `Unsupported selector "${sel}" — use tag, .class, #id, tag.class, [attr=value], "text", "title" or "links".` };
    }
    const matches = this.page.elements.filter((e) => matchesSelector(e, parsed)).slice(0, 50);
    return {
      ok: true,
      summary: `Selector "${sel}" matched ${matches.length} element(s).`,
      data: matches.map((e) => ({ ref: e.ref, tag: e.tag, text: e.text, attributes: e.attributes })),
    };
  }

  private doScreenshot(): Promise<WebActionResult> {
    if (!this.page) return Promise.resolve({ ok: false, summary: "No page is open — call browser_open first." });
    const width = 800;
    const headerHeight = 64;
    const lineHeight = 18;
    const lines = wrapText(this.page.text || "(empty page)", SCREENSHOT_LINE_WIDTH).slice(0, MAX_SCREENSHOT_LINES);
    const height = headerHeight + 16 + lines.length * lineHeight + 24;

    const esc = (s: string): string =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const bodyLines = lines
      .map((line, i) => `<text x="24" y="${headerHeight + 16 + (i + 1) * lineHeight}" fill="#c9d1d9" font-family="monospace" font-size="13">${esc(line)}</text>`)
      .join("\n  ");

    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `  <rect width="${width}" height="${height}" fill="#0a0e14"/>`,
      `  <rect width="${width}" height="${headerHeight}" fill="#11161f"/>`,
      `  <circle cx="28" cy="${headerHeight / 2}" r="6" fill="#ff5252"/>`,
      `  <circle cx="48" cy="${headerHeight / 2}" r="6" fill="#FFAE00"/>`,
      `  <circle cx="68" cy="${headerHeight / 2}" r="6" fill="#14F195"/>`,
      `  <text x="90" y="28" fill="#3DCED6" font-family="monospace" font-size="13">${esc(this.page.finalUrl.slice(0, 100))}</text>`,
      `  <text x="90" y="50" fill="#ffffff" font-family="monospace" font-size="14">${esc((this.page.title || "untitled").slice(0, 90))}</text>`,
      `  ${bodyLines}`,
      `</svg>`,
    ].join("\n");

    const headings = this.page.elements
      .filter((e) => /^h[1-6]$/.test(e.tag) && e.text)
      .slice(0, 10)
      .map((e) => `${e.tag.toUpperCase()}: ${e.text.slice(0, 80)}`);
    const summary = [
      `Screenshot of ${this.page.finalUrl} — "${this.page.title || "untitled"}"`,
      headings.length ? `Headings: ${headings.join(" | ")}` : "No headings.",
      `Text: ${this.page.text.slice(0, 500)}`,
    ].join("\n");

    return Promise.resolve({
      ok: true,
      summary: `Captured SVG snapshot (${width}×${height}) of ${this.page.finalUrl}.`,
      data: { svg, summary, width, height } satisfies ScreenshotResult,
    });
  }

  private async doResearch(query: string): Promise<WebActionResult> {
    if (!query.trim()) return { ok: false, summary: "research_query requires a non-empty query." };
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const { res } = await this.request({
      method: "GET",
      url,
      headers: { "user-agent": "CapixIDE WebControl/1.0" },
    });
    if (res.status < 200 || res.status >= 400) {
      return { ok: false, summary: `Research query failed — HTTP ${res.status} from search endpoint.` };
    }
    const results = parseResearchResults(res.body);
    if (!results.length) {
      return { ok: true, summary: `No results for "${query}".`, data: [] };
    }
    const summary = results
      .map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`)
      .join("\n");
    return { ok: true, summary: `${results.length} result(s) for "${query}":\n${summary}`, data: results };
  }

  private async doDocsLookup(topic: string): Promise<WebActionResult> {
    if (!topic.trim()) return { ok: false, summary: "docs_lookup requires a non-empty topic." };
    const mdnUrl = `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(topic)}&locale=en-US`;
    try {
      const { res } = await this.request({ method: "GET", url: mdnUrl });
      if (res.status >= 200 && res.status < 400) {
        const docs = parseMdnResults(res.body);
        if (docs.length) {
          const summary = docs.map((d, i) => `${i + 1}. ${d.title} — ${d.url}\n   ${d.summary}`).join("\n");
          return { ok: true, summary: `${docs.length} doc(s) for "${topic}" (MDN):\n${summary}`, data: docs };
        }
      }
    } catch {
      // Fall through to the research-backed lookup below.
    }
    const fallback = await this.doResearch(`site:developer.mozilla.org ${topic}`);
    return { ...fallback, summary: `MDN lookup unavailable; research fallback.\n${fallback.summary}` };
  }

  private async doApiTest(req: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<WebActionResult> {
    this.assertHttpUrl(req.url);
    const method = (req.method ?? (req.body ? "POST" : "GET")).toUpperCase();
    const { res, durationMs } = await this.request({
      method,
      url: req.url,
      headers: req.headers,
      body: req.body,
      timeoutMs: req.timeoutMs,
    });
    const bodyCap = cap(res.body, MAX_BODY_CHARS);
    const result: ApiTestResult = {
      status: res.status,
      statusText: res.statusText,
      durationMs,
      headers: res.headers,
      body: bodyCap.text,
      truncated: bodyCap.truncated,
    };
    const ok = res.status >= 200 && res.status < 400;
    return {
      ok,
      summary: `${method} ${req.url} → HTTP ${res.status} in ${durationMs}ms (${res.body.length} bytes${bodyCap.truncated ? ", truncated" : ""})`,
      data: result,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Parse DuckDuckGo HTML result anchors into structured results. */
export function parseResearchResults(html: string): ResearchResult[] {
  const results: ResearchResult[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snippetRe.exec(html)) && snippets.length < MAX_RESEARCH_RESULTS) {
    snippets.push(collapseWhitespace(decodeEntities(m[1].replace(/<[^>]+>/g, " "))));
  }
  let i = 0;
  while ((m = anchorRe.exec(html)) && results.length < MAX_RESEARCH_RESULTS) {
    const rawUrl = decodeEntities(m[1]);
    // DDG wraps outbound links in a redirect: //duckduckgo.com/l/?uddg=<url>
    let url = rawUrl;
    const uddg = /[?&]uddg=([^&]+)/.exec(rawUrl);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        url = rawUrl;
      }
    }
    results.push({
      title: collapseWhitespace(decodeEntities(m[2].replace(/<[^>]+>/g, " "))),
      url,
      snippet: snippets[i] ?? "",
    });
    i++;
  }
  return results;
}

/** Parse the MDN search API response ({ documents: [...] }). */
export function parseMdnResults(body: string): DocResult[] {
  try {
    const json = JSON.parse(body) as {
      documents?: Array<{ title?: string; mdn_url?: string; summary?: string }>;
    };
    return (json.documents ?? [])
      .filter((d) => d.title && d.mdn_url)
      .slice(0, MAX_RESEARCH_RESULTS)
      .map((d) => ({
        title: d.title!,
        url: `https://developer.mozilla.org${d.mdn_url}`,
        summary: collapseWhitespace(d.summary ?? "").slice(0, 300),
      }));
  } catch {
    return [];
  }
}
