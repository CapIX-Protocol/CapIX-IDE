/**
 * Browser Tools — the agent-runtime tool definitions that expose the
 * {@link WebControlManager} to the Capix assistant.
 *
 * Tools:
 *   browser_open        navigate to a URL and parse the page
 *   browser_click       click a link or submit button (by element ref)
 *   browser_type        fill a form field (by element ref)
 *   browser_extract     pull content out of the page (selector or "text")
 *   browser_screenshot  capture an SVG snapshot + text summary of the page
 *   research_query      web research via the DuckDuckGo HTML endpoint
 *   docs_lookup         documentation lookup (MDN, research fallback)
 *   api_test            fire a raw HTTP request and inspect the response
 *
 * Every tool sets `alwaysRequiresApproval` — the shared runtime therefore
 * gates each call on an explicit operator Approve regardless of session
 * mode, and the panel surfaces an approval card before anything touches
 * the network.
 */

import type { ToolDefinition } from "./shared/agent-runtime/tools";
import type { WebControlManager } from "./webControl";

/** Names of every web-control tool, for tests and approval UIs. */
export const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_extract",
  "browser_screenshot",
  "research_query",
  "docs_lookup",
  "api_test",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

/** Human-readable one-liner for the approval card of a browser tool call. */
export function describeBrowserToolCall(tool: string, args: Record<string, unknown>): string {
  const target =
    args.url ?? args.ref ?? args.selector ?? args.query ?? args.topic ?? "";
  const summary = typeof target === "string" && target ? ` ${target}` : "";
  return `${tool}${summary}`.slice(0, 200);
}

function asString(value: unknown, name: string): string {
  const s = typeof value === "string" ? value : "";
  if (!s.trim()) throw new Error(`${name} is required`);
  return s;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Build the browser tool definitions bound to a shared web-control manager. */
export function createBrowserTools(manager: WebControlManager): ToolDefinition[] {
  return [
    {
      name: "browser_open",
      description:
        "Open a URL in web control. Fetches the page, parses it into an element model (links, forms, inputs) and returns a summary. Element refs from the response are used by browser_click / browser_type / browser_extract.",
      riskClass: "network",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.open(asString(args.url, "url"));
        if (!result.ok) return { output: result.summary, isError: true };
        const page = manager.getPage();
        return {
          output: [
            result.summary,
            page?.text ? `\nPage text (capped):\n${page.text.slice(0, 4000)}` : "",
            page?.links.length
              ? `\nLinks:\n${page.links.slice(0, 25).map((l) => `${l.ref} ${l.text.slice(0, 60)} → ${l.href}`).join("\n")}`
              : "",
            page?.forms.length
              ? `\nForms:\n${page.forms.map((f) => `${f.ref} ${f.method} ${f.action || "(self)"} fields: ${Object.keys(f.fields).join(", ") || "none"}`).join("\n")}`
              : "",
          ].join(""),
        };
      },
    },
    {
      name: "browser_click",
      description:
        "Click an element on the current page by ref (e.g. \"e3\"). Links navigate to their href; submit buttons submit the enclosing form with the values set via browser_type.",
      riskClass: "network",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.click(asString(args.ref, "ref"));
        return { output: result.summary, isError: !result.ok };
      },
    },
    {
      name: "browser_type",
      description:
        "Type text into a form field on the current page, addressed by element ref. The value is stored in the form state and sent when the form is submitted via browser_click on its submit button.",
      riskClass: "network",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.typeText(
          asString(args.ref, "ref"),
          typeof args.text === "string" ? args.text : "",
        );
        return { output: result.summary, isError: !result.ok };
      },
    },
    {
      name: "browser_extract",
      description:
        "Extract content from the current page. Pass \"text\" for the full page text, \"title\", \"links\", or a simple selector: tag, .class, #id, tag.class or [attr=value].",
      riskClass: "read",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.extract(asString(args.selector, "selector"));
        if (!result.ok) return { output: result.summary, isError: true };
        const data =
          typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
        return {
          output: `${result.summary}\n${(data ?? "").slice(0, 8000)}`,
        };
      },
    },
    {
      name: "browser_screenshot",
      description:
        "Capture a visual snapshot of the current page: a rendered SVG plus a text summary (headings and leading text) for analysis.",
      riskClass: "read",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.screenshot();
        if (!result.ok) return { output: result.summary, isError: true };
        const shot = result.data as { summary?: string } | undefined;
        return { output: shot?.summary ?? result.summary };
      },
    },
    {
      name: "research_query",
      description:
        "Run a web research query and return ranked results (title, URL, snippet) from the DuckDuckGo HTML endpoint.",
      riskClass: "network",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.research(asString(args.query, "query"));
        return { output: result.summary, isError: !result.ok };
      },
    },
    {
      name: "docs_lookup",
      description:
        "Look up documentation for a topic. Queries the MDN search API first and falls back to a site-restricted research query.",
      riskClass: "network",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.docsLookup(asString(args.topic, "topic"));
        return { output: result.summary, isError: !result.ok };
      },
    },
    {
      name: "api_test",
      description:
        "Test an HTTP API endpoint: sends the request with the given method/headers/body and returns status, timing, response headers and a capped body.",
      riskClass: "network",
      alwaysRequiresApproval: true,
      async execute(args) {
        const result = await manager.apiTest({
          url: asString(args.url, "url"),
          method: typeof args.method === "string" ? args.method : undefined,
          headers: asStringRecord(args.headers),
          body: typeof args.body === "string" ? args.body : undefined,
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        });
        if (!result.ok) return { output: result.summary, isError: true };
        const data = result.data as { headers?: Record<string, string>; body?: string };
        return {
          output: [
            result.summary,
            `\nResponse headers:\n${JSON.stringify(data.headers ?? {}, null, 2)}`,
            `\nBody:\n${(data.body ?? "").slice(0, 8000)}`,
          ].join(""),
        };
      },
    },
  ];
}
