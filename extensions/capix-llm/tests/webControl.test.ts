import { describe, it, expect, beforeEach } from "vitest";
import {
  WebControlManager,
  parseMdnResults,
  parseResearchResults,
  type HttpRequest,
  type HttpResponse,
} from "../src/webControl";

const EXAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Example Page</title><style>body{color:red}</style></head>
<body>
<h1>Hello Capix</h1>
<p class="intro">Welcome to the example.</p>
<a href="/about">About us</a>
<a id="docs-link" href="https://docs.example.com/x">Docs</a>
<form action="/search" method="get">
  <input type="text" name="q" value="">
  <button type="submit">Search</button>
</form>
<script>var secret = "should-not-appear";</script>
</body>
</html>`;

const ABOUT_HTML = `<html><head><title>About</title></head><body><h1>About us</h1><p>We are example.</p></body></html>`;
const SEARCH_HTML = `<html><head><title>Search results</title></head><body><h1>Results</h1><p>1 result found</p></body></html>`;

const DDG_HTML = `<html><body>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcapix.network%2Fdocs&amp;rut=abc">Capix Docs</a>
<a class="result__snippet" href="#">The Capix documentation hub.</a>
<a class="result__a" href="https://example.com/direct">Direct Result</a>
<a class="result__snippet" href="#">A direct link.</a>
</body></html>`;

const MDN_JSON = JSON.stringify({
  documents: [
    { title: "fetch()", mdn_url: "/en-US/docs/Web/API/fetch", summary: "The fetch() method starts the process of fetching a resource." },
    { title: "Response", mdn_url: "/en-US/docs/Web/API/Response", summary: "The Response interface of the Fetch API." },
  ],
});

type Handler = (req: HttpRequest) => HttpResponse;

function htmlResponse(body: string, url?: string): HttpResponse {
  return { status: 200, statusText: "OK", headers: { "content-type": "text/html; charset=utf-8" }, body, url };
}

function jsonResponse(body: string, status = 200): HttpResponse {
  return { status, statusText: "OK", headers: { "content-type": "application/json" }, body };
}

/** Build a manager whose transport routes by URL; records every request. */
function makeManager(routes: Record<string, HttpResponse | Handler>) {
  const requests: HttpRequest[] = [];
  const manager = new WebControlManager({
    transport: async (req) => {
      requests.push(req);
      const route = Object.entries(routes).find(([prefix]) => req.url.startsWith(prefix));
      if (!route) return { status: 404, statusText: "Not Found", headers: {}, body: "not found" };
      const value = route[1];
      return typeof value === "function" ? value(req) : value;
    },
  });
  return { manager, requests };
}

function defaultRoutes(): Record<string, HttpResponse | Handler> {
  return {
    "https://example.com/about": htmlResponse(ABOUT_HTML, "https://example.com/about"),
    "https://example.com/search": htmlResponse(SEARCH_HTML, "https://example.com/search"),
    "https://example.com": htmlResponse(EXAMPLE_HTML, "https://example.com/"),
  };
}

describe("WebControlManager — open & parse", () => {
  let manager: WebControlManager;
  let requests: HttpRequest[];

  beforeEach(() => {
    ({ manager, requests } = makeManager(defaultRoutes()));
  });

  it("opens a URL and parses title, text, links and forms", async () => {
    const result = await manager.open("https://example.com/");
    expect(result.ok).toBe(true);

    const page = manager.getPage();
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Example Page");
    expect(page!.finalUrl).toBe("https://example.com/");
    expect(page!.status).toBe(200);
    expect(page!.text).toContain("Hello Capix");
    expect(page!.text).toContain("Welcome to the example.");
    expect(page!.text).not.toContain("should-not-appear");

    expect(page!.links).toHaveLength(2);
    expect(page!.links[0].text).toBe("About us");
    expect(page!.links[0].href).toBe("/about");

    expect(page!.forms).toHaveLength(1);
    expect(page!.forms[0].method).toBe("GET");
    expect(page!.forms[0].action).toBe("/search");
    expect(page!.forms[0].fields).toEqual({ q: "" });
  });

  it("records a network log entry per request", async () => {
    await manager.open("https://example.com/");
    const log = manager.getNetworkLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ method: "GET", url: "https://example.com/", status: 200 });
    expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(log[0].bytes).toBe(EXAMPLE_HTML.length);
  });

  it("rejects invalid URLs and non-http(s) protocols", async () => {
    await expect(manager.open("not a url")).rejects.toThrow("invalid URL");
    await expect(manager.open("file:///etc/passwd")).rejects.toThrow("unsupported protocol");
    expect(requests).toHaveLength(0);
  });

  it("handles non-HTML responses without crashing the parser", async () => {
    const { manager: m } = makeManager({ "https://api.example.com": jsonResponse('{"ok":true}') });
    const result = await m.open("https://api.example.com/data");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("non-HTML");
    expect(m.getPage()).toBeNull();
  });

  it("reports ok=false for HTTP error statuses", async () => {
    const { manager: m } = makeManager({});
    const result = await m.open("https://missing.example.com/");
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("404");
  });
});

describe("WebControlManager — extract", () => {
  let manager: WebControlManager;

  beforeEach(async () => {
    ({ manager } = makeManager(defaultRoutes()));
    await manager.open("https://example.com/");
  });

  it("extracts full text, title and links", async () => {
    expect((await manager.extract("text")).data).toContain("Hello Capix");
    expect((await manager.extract("title")).data).toBe("Example Page");
    const links = await manager.extract("links");
    expect(Array.isArray(links.data)).toBe(true);
    expect((links.data as unknown[]).length).toBe(2);
  });

  it("matches simple selectors: tag, #id, .class", async () => {
    const byTag = await manager.extract("h1");
    expect((byTag.data as Array<{ text: string }>)[0].text).toBe("Hello Capix");

    const byId = await manager.extract("#docs-link");
    expect((byId.data as Array<{ attributes: Record<string, string> }>)[0].attributes.href)
      .toBe("https://docs.example.com/x");

    const byClass = await manager.extract("p.intro");
    expect((byClass.data as Array<{ text: string }>)[0].text).toBe("Welcome to the example.");
  });

  it("rejects unsupported selectors with a helpful message", async () => {
    const result = await manager.extract("div > p");
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Unsupported selector");
  });

  it("fails cleanly when no page is open", async () => {
    const { manager: fresh } = makeManager(defaultRoutes());
    const result = await fresh.extract("text");
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("browser_open");
  });
});

describe("WebControlManager — click, type, forms", () => {
  let manager: WebControlManager;
  let requests: HttpRequest[];

  beforeEach(async () => {
    ({ manager, requests } = makeManager(defaultRoutes()));
    await manager.open("https://example.com/");
  });

  it("clicking a link navigates to its resolved href", async () => {
    const link = manager.getPage()!.links[0];
    const result = await manager.click(link.ref);
    expect(result.ok).toBe(true);
    expect(manager.getPage()!.title).toBe("About");
    expect(manager.getPage()!.finalUrl).toBe("https://example.com/about");
  });

  it("typing into a field then clicking submit performs a GET form submission", async () => {
    const page = manager.getPage()!;
    const input = page.elements.find((e) => e.tag === "input" && e.attributes.name === "q")!;
    const submit = page.elements.find((e) => e.tag === "button")!;

    const typed = await manager.typeText(input.ref, "hello world");
    expect(typed.ok).toBe(true);

    const clicked = await manager.click(submit.ref);
    expect(clicked.ok).toBe(true);
    const last = requests[requests.length - 1];
    expect(last.url).toBe("https://example.com/search?q=hello+world");
    expect(manager.getPage()!.title).toBe("Search results");
  });

  it("submits POST forms with urlencoded bodies", async () => {
    const postHtml = `<html><body><form action="/login" method="post">
      <input type="text" name="user"><input type="password" name="pass">
      <input type="submit" value="Go"></form></body></html>`;
    const { manager: m, requests: reqs } = makeManager({
      "https://app.example.com/login": (req) =>
        req.method === "POST"
          ? jsonResponse('{"session":"abc"}')
          : htmlResponse(postHtml, "https://app.example.com/login"),
      "https://app.example.com": htmlResponse(postHtml, "https://app.example.com/"),
    });
    await m.open("https://app.example.com/");
    const page = m.getPage()!;
    await m.typeText(page.elements.find((e) => e.attributes.name === "user")!.ref, "rui");
    await m.typeText(page.elements.find((e) => e.attributes.name === "pass")!.ref, "s3cret");
    const result = await m.click(page.elements.find((e) => e.attributes.type === "submit")!.ref);
    expect(result.ok).toBe(true);
    const post = reqs.find((r) => r.method === "POST")!;
    expect(post.body).toBe("user=rui&pass=s3cret");
    expect(post.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("refuses to click non-actionable elements", async () => {
    const h1 = manager.getPage()!.elements.find((e) => e.tag === "h1")!;
    const result = await manager.click(h1.ref);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not actionable");
  });

  it("refuses to type into non-field elements", async () => {
    const h1 = manager.getPage()!.elements.find((e) => e.tag === "h1")!;
    const result = await manager.typeText(h1.ref, "nope");
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not a text field");
  });

  it("reports unknown element refs", async () => {
    expect((await manager.click("e999")).ok).toBe(false);
    expect((await manager.typeText("e999", "x")).ok).toBe(false);
  });
});

describe("WebControlManager — screenshot & inspect", () => {
  let manager: WebControlManager;

  beforeEach(async () => {
    ({ manager } = makeManager(defaultRoutes()));
    await manager.open("https://example.com/");
  });

  it("captures an SVG snapshot with the page URL, title and text", async () => {
    const result = await manager.screenshot();
    expect(result.ok).toBe(true);
    const shot = result.data as { svg: string; summary: string; width: number; height: number };
    expect(shot.svg).toContain("<svg");
    expect(shot.svg).toContain("https://example.com/");
    expect(shot.svg).toContain("Example Page");
    expect(shot.svg).toContain("Hello Capix");
    expect(shot.summary).toContain("H1: Hello Capix");
    expect(shot.width).toBe(800);
    expect(shot.height).toBeGreaterThan(64);
  });

  it("escapes HTML in snapshots", async () => {
    const { manager: m } = makeManager({
      "https://evil.example.com": htmlResponse(
        `<html><head><title>x</title></head><body><p>&lt;script&gt; alert(1)</p></body></html>`,
        "https://evil.example.com/",
      ),
    });
    await m.open("https://evil.example.com/");
    const shot = (await m.screenshot()).data as { svg: string };
    expect(shot.svg).not.toContain("<script>");
  });

  it("inspects elements with full attributes", async () => {
    const link = manager.getPage()!.elements.find((e) => e.attributes.id === "docs-link")!;
    const result = await manager.inspect(link.ref);
    expect(result.ok).toBe(true);
    const el = result.data as { tag: string; attributes: Record<string, string> };
    expect(el.tag).toBe("a");
    expect(el.attributes.href).toBe("https://docs.example.com/x");
    expect((await manager.inspect("e999")).ok).toBe(false);
  });
});

describe("WebControlManager — research, docs, api_test", () => {
  it("parses research results and unwraps redirect URLs", async () => {
    const { manager } = makeManager({
      "https://html.duckduckgo.com": htmlResponse(DDG_HTML),
    });
    const result = await manager.research("capix docs");
    expect(result.ok).toBe(true);
    const results = result.data as Array<{ title: string; url: string; snippet: string }>;
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Capix Docs");
    expect(results[0].url).toBe("https://capix.network/docs");
    expect(results[0].snippet).toContain("documentation hub");
    expect(results[1].url).toBe("https://example.com/direct");
  });

  it("rejects empty research queries without hitting the network", async () => {
    const { manager, requests } = makeManager({});
    expect((await manager.research("  ")).ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("looks up docs via the MDN search API", async () => {
    const { manager } = makeManager({
      "https://developer.mozilla.org/api/v1/search": jsonResponse(MDN_JSON),
    });
    const result = await manager.docsLookup("fetch");
    expect(result.ok).toBe(true);
    const docs = result.data as Array<{ title: string; url: string }>;
    expect(docs[0]).toEqual({
      title: "fetch()",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
      summary: expect.stringContaining("fetch"),
    });
  });

  it("falls back to research when MDN is unavailable", async () => {
    const { manager } = makeManager({
      "https://html.duckduckgo.com": htmlResponse(DDG_HTML),
      "https://developer.mozilla.org": jsonResponse("{}", 503),
    });
    const result = await manager.docsLookup("fetch");
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("research fallback");
  });

  it("runs api_test requests and captures status, timing and body", async () => {
    const { manager, requests } = makeManager({
      "https://api.example.com/v1/models": jsonResponse('{"data":["m1"]}'),
    });
    const result = await manager.apiTest({
      method: "POST",
      url: "https://api.example.com/v1/models",
      headers: { authorization: "Bearer k" },
      body: '{"q":1}',
    });
    expect(result.ok).toBe(true);
    const data = result.data as { status: number; durationMs: number; body: string; truncated: boolean };
    expect(data.status).toBe(200);
    expect(data.body).toBe('{"data":["m1"]}');
    expect(data.truncated).toBe(false);
    expect(requests[0]).toMatchObject({ method: "POST", body: '{"q":1}' });
    expect(manager.getNetworkLog()[0].url).toBe("https://api.example.com/v1/models");
  });

  it("marks api_test ok=false on error statuses", async () => {
    const { manager } = makeManager({});
    const result = await manager.apiTest({ url: "https://nothing.example.com/" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("404");
  });
});

describe("WebControlManager — history & replay", () => {
  it("records every action in order and clears on demand", async () => {
    const { manager } = makeManager(defaultRoutes());
    await manager.open("https://example.com/");
    await manager.extract("text");
    await manager.screenshot();

    const history = manager.getHistory();
    expect(history.map((a) => a.tool)).toEqual(["browser_open", "browser_extract", "browser_screenshot"]);
    expect(history.every((a) => a.ok)).toBe(true);
    expect(history[0].id).toBeLessThan(history[1].id);

    manager.clearHistory();
    expect(manager.getHistory()).toHaveLength(0);
    expect(manager.getNetworkLog()).toHaveLength(0);
  });

  it("replays the full action sequence from scratch", async () => {
    const { manager, requests } = makeManager(defaultRoutes());
    await manager.open("https://example.com/");
    const link = manager.getPage()!.links[0];
    await manager.click(link.ref);
    expect(manager.getPage()!.title).toBe("About");

    requests.length = 0;
    const results = await manager.replay();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // Two fresh fetches: open + the click navigation; no new history entries.
    expect(requests).toHaveLength(2);
    expect(manager.getPage()!.title).toBe("About");
    expect(manager.getHistory()).toHaveLength(2);
  });

  it("replays from a specific action id", async () => {
    const { manager, requests } = makeManager(defaultRoutes());
    await manager.open("https://example.com/");
    const link = manager.getPage()!.links[0];
    await manager.click(link.ref);
    const clickId = manager.getHistory()[1].id;

    // Replaying starts from a blank page, so a click whose page is gone
    // fails cleanly instead of crashing.
    requests.length = 0;
    const results = await manager.replay(clickId);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("reports unknown replay ids", async () => {
    const { manager } = makeManager(defaultRoutes());
    const results = await manager.replay(12345);
    expect(results[0].ok).toBe(false);
    expect(results[0].summary).toContain("12345");
  });
});

describe("WebControlManager — describeState", () => {
  it("summarises the empty state and the loaded page", async () => {
    const { manager } = makeManager(defaultRoutes());
    expect(manager.describeState()).toContain("No page is currently open");
    await manager.open("https://example.com/");
    const desc = manager.describeState();
    expect(desc).toContain("Example Page");
    expect(desc).toContain("https://example.com/");
    expect(desc).toContain("browser_open(ok)");
  });
});

describe("response parsers", () => {
  it("parseResearchResults handles empty pages", () => {
    expect(parseResearchResults("<html><body>nothing</body></html>")).toEqual([]);
  });

  it("parseMdnResults tolerates malformed JSON", () => {
    expect(parseMdnResults("not json")).toEqual([]);
    expect(parseMdnResults("{}")).toEqual([]);
  });
});
