import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCapixJsonText, parseCapixSseText } from "../../../src/vs/workbench/contrib/capix-ai/common/capixResponseParser";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("Capix production response contract", () => {
  it("keeps OpenAI-compatible non-streaming message content", () => {
    expect(extractCapixJsonText(JSON.parse(fixture("chat-nonstream.production.json"))))
      .toBe("Capix JSON response fixture.");
  });

  it("combines named Capix events and OpenAI delta events without dropping text", () => {
    expect(parseCapixSseText(fixture("chat-stream.production.txt"))).toEqual({
      text: "Capix stream response fixture.",
      receiptId: "cpxr_sse_fixture",
      error: undefined,
    });
  });

  it("keeps valid text even when a later stream error is present", () => {
    const parsed = parseCapixSseText('event: content.delta\ndata: {"content":"kept"}\n\nevent: capix.error\ndata: {"message":"retry"}\n\n');
    expect(parsed).toEqual({ text: "kept", receiptId: undefined, error: "retry" });
  });
});
