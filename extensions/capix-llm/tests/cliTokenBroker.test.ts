import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
  },
}));

import { CliTokenBroker } from "../src/cliTokenBroker";

const okRunner = (token: string) =>
  vi.fn(async () => ({ stdout: JSON.stringify({ access_token: token }), stderr: "" }));

const failRunner = () =>
  vi.fn(async () => {
    throw new Error("not signed in");
  });

describe("CliTokenBroker", () => {
  it("returns the parsed access token", async () => {
    const broker = new CliTokenBroker(okRunner("tok_abc"));
    await expect(broker.getAccessToken()).resolves.toBe("tok_abc");
  });

  it("caches the token and does not re-invoke the CLI within the TTL", async () => {
    const run = okRunner("tok_cached");
    const broker = new CliTokenBroker(run);
    await broker.getAccessToken();
    await broker.getAccessToken();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent fetches", async () => {
    const run = okRunner("tok_single");
    const broker = new CliTokenBroker(run);
    const [a, b] = await Promise.all([broker.getAccessToken(), broker.getAccessToken()]);
    expect(a).toBe("tok_single");
    expect(b).toBe("tok_single");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the CLI has no session", async () => {
    const broker = new CliTokenBroker(failRunner());
    await expect(broker.getAccessToken()).rejects.toThrow("Not signed in");
  });

  it("re-fetches after invalidate()", async () => {
    const run = okRunner("tok_new");
    const broker = new CliTokenBroker(run);
    await broker.getAccessToken();
    broker.invalidate();
    await broker.getAccessToken();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed CLI output", async () => {
    const broker = new CliTokenBroker(async () => ({ stdout: "not json", stderr: "" }));
    await expect(broker.getAccessToken()).rejects.toThrow("Not signed in");
  });
});
