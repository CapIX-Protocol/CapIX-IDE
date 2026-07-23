import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("CapixIDE authentication isolation", () => {
  it("does not automatically execute the standalone Capix Code CLI for auth", () => {
    const source = readFileSync(resolve(__dirname, "../src/extension.ts"), "utf8");
    expect(source).not.toContain('from "./cliTokenBroker"');
    expect(source).not.toContain("new CliTokenBroker");
    expect(source).toContain("getAccessToken: () => authBroker.getAccessToken()");
  });
});
