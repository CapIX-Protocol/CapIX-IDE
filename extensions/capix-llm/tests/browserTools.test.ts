import { describe, it, expect, beforeEach } from "vitest";
import { WebControlManager, type HttpResponse } from "../src/webControl";
import { BROWSER_TOOL_NAMES, createBrowserTools, describeBrowserToolCall } from "../src/browserTools";

const PAGE_HTML = `<html><head><title>Tools Page</title></head><body>
<h1>Tools</h1><p>Some text here.</p><a href="/next">Next</a>
</body></html>`;

function makeManager() {
  return new WebControlManager({
    transport: async (req): Promise<HttpResponse> => {
      if (req.url.startsWith("https://api.example.com")) {
        return { status: 200, statusText: "OK", headers: { "content-type": "application/json", "x-req-id": "1" }, body: '{"ok":true}' };
      }
      return { status: 200, statusText: "OK", headers: { "content-type": "text/html" }, body: PAGE_HTML, url: req.url };
    },
  });
}

const CTX = { sessionId: "s1", turnId: "t1", workspaceRoot: "/tmp" };

describe("createBrowserTools", () => {
  let manager: WebControlManager;
  let tools: ReturnType<typeof createBrowserTools>;

  beforeEach(() => {
    manager = makeManager();
    tools = createBrowserTools(manager);
  });

  it("exposes exactly the eight web-control tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
  });

  it("requires explicit approval for every tool, regardless of mode", () => {
    for (const tool of tools) {
      expect(tool.alwaysRequiresApproval).toBe(true);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("browser_open fetches and summarises the page", async () => {
    const tool = tools.find((t) => t.name === "browser_open")!;
    const result = await tool.execute({ url: "https://example.com/" }, CTX);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Tools Page");
    expect(result.output).toContain("Links:");
    expect(manager.getPage()!.title).toBe("Tools Page");
  });

  it("browser_open requires a url argument", async () => {
    const tool = tools.find((t) => t.name === "browser_open")!;
    await expect(tool.execute({}, CTX)).rejects.toThrow("url is required");
  });

  it("browser_click navigates via element refs from the open page", async () => {
    await tools.find((t) => t.name === "browser_open")!.execute({ url: "https://example.com/" }, CTX);
    const ref = manager.getPage()!.links[0].ref;
    const result = await tools.find((t) => t.name === "browser_click")!.execute({ ref }, CTX);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Clicked");
    expect(manager.getPage()!.finalUrl).toBe("https://example.com/next");
  });

  it("browser_click surfaces failures as error results (not throws)", async () => {
    const result = await tools.find((t) => t.name === "browser_click")!.execute({ ref: "e1" }, CTX);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No page is open");
  });

  it("browser_type validates its ref argument", async () => {
    const tool = tools.find((t) => t.name === "browser_type")!;
    await expect(tool.execute({ text: "x" }, CTX)).rejects.toThrow("ref is required");
  });

  it("browser_extract returns selector matches as JSON", async () => {
    await tools.find((t) => t.name === "browser_open")!.execute({ url: "https://example.com/" }, CTX);
    const result = await tools.find((t) => t.name === "browser_extract")!.execute({ selector: "h1" }, CTX);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("matched 1 element");
    expect(result.output).toContain("Tools");
  });

  it("browser_screenshot returns the text summary for analysis", async () => {
    await tools.find((t) => t.name === "browser_open")!.execute({ url: "https://example.com/" }, CTX);
    const result = await tools.find((t) => t.name === "browser_screenshot")!.execute({}, CTX);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Screenshot of https://example.com/");
    expect(result.output).toContain("H1: Tools");
  });

  it("research_query and docs_lookup pass queries through to the manager", async () => {
    const ddg = `<a class="result__a" href="https://example.com/r">R</a><a class="result__snippet" href="#">S</a>`;
    const m = new WebControlManager({
      transport: async (req): Promise<HttpResponse> => ({
        status: 200, statusText: "OK", headers: { "content-type": "text/html" }, body: ddg, url: req.url,
      }),
    });
    const t = createBrowserTools(m);
    const research = await t.find((x) => x.name === "research_query")!.execute({ query: "capix" }, CTX);
    expect(research.isError).toBeFalsy();
    expect(research.output).toContain("1 result(s)");
    const docs = await t.find((x) => x.name === "docs_lookup")!.execute({ topic: "fetch" }, CTX);
    expect(docs.isError).toBeFalsy();
  });

  it("api_test returns status, headers and body", async () => {
    const result = await tools.find((t) => t.name === "api_test")!.execute(
      { url: "https://api.example.com/v1/models", method: "GET" },
      CTX,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("HTTP 200");
    expect(result.output).toContain("x-req-id");
    expect(result.output).toContain('{"ok":true}');
  });
});

describe("describeBrowserToolCall", () => {
  it("summarises the tool with its primary target", () => {
    expect(describeBrowserToolCall("browser_open", { url: "https://x.dev" })).toBe("browser_open https://x.dev");
    expect(describeBrowserToolCall("browser_click", { ref: "e7" })).toBe("browser_click e7");
    expect(describeBrowserToolCall("research_query", { query: "capix" })).toBe("research_query capix");
    expect(describeBrowserToolCall("browser_screenshot", {})).toBe("browser_screenshot");
  });

  it("caps long descriptions", () => {
    const long = describeBrowserToolCall("browser_open", { url: `https://x.dev/${"a".repeat(500)}` });
    expect(long.length).toBeLessThanOrEqual(200);
  });
});
