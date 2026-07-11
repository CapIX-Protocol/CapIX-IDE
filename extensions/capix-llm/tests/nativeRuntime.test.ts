import { describe, expect, it, vi } from "vitest";
import { CapixMainBroker } from "../../../src/main/capix-broker";
import { CAPIX_BROKER_CHANNEL, parseRendererMessage, registerCapixIpc } from "../../../src/main/capix-ipc-registration";
import { CapixNativePkceAuth } from "../../../src/main/capix-native-auth";

describe("native Capix runtime", () => {
  it("rejects untyped and malformed IPC before broker dispatch", () => {
    expect(() => parseRendererMessage({ type: "fetch", url: "https://evil.example" })).toThrow();
    expect(() => parseRendererMessage({ type: "auth:login:callback", code: "", state: "x" })).toThrow();
  });

  it("registers one versioned Electron channel and validates sender origin", async () => {
    let listener: ((event: any, input: unknown) => Promise<unknown>) | undefined;
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((_channel, fn) => { listener = fn; }) };
    const sdk = { catalog: { listModels: vi.fn().mockResolvedValue([{ id: "model-1" }]) } } as any;
    const auth = { startLogin: vi.fn(), completeLogin: vi.fn(), logout: vi.fn() };
    const dispose = registerCapixIpc(ipc, new CapixMainBroker({ sdk, auth }));
    expect(ipc.handle).toHaveBeenCalledWith(CAPIX_BROKER_CHANNEL, expect.any(Function));
    await expect(listener!({ sender: { id: 7, getURL: () => "https://evil.example/workbench" } }, { type: "catalog:models" })).rejects.toThrow(/untrusted origin/);
    await expect(listener!({ sender: { id: 7, getURL: () => "vscode-file://vscode-app/out/vs/workbench/workbench.html" } }, { type: "catalog:models" })).resolves.toEqual([{ id: "model-1" }]);
    await expect(listener!({ sender: { id: 7, getURL: () => "https://www.capix.network/workbench" } }, { type: "catalog:models" })).resolves.toEqual([{ id: "model-1" }]);
    dispose();
    expect(ipc.removeHandler).toHaveBeenLastCalledWith(CAPIX_BROKER_CHANNEL);
  });

  it("completes system-browser PKCE through an ephemeral loopback callback", async () => {
    let authorizeUrl = "";
    const secrets = new Map<string, string>();
    const store = {
      get: vi.fn(async (_service: string, account: string) => secrets.get(account) ?? null),
      set: vi.fn(async (_service: string, account: string, value: string) => { secrets.set(account, value); }),
      delete: vi.fn(async (_service: string, account: string) => { secrets.delete(account); }),
    };
    const tokenFetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 300, account_id: "acct-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const auth = new CapixNativePkceAuth({ baseUrl: "https://www.capix.network", authorizePath: "/oauth/authorize", tokenPath: "/oauth/token", revokePath: "/oauth/revoke", clientId: "capix-ide", scope: "openid account catalog" }, store, { openExternal: async (url) => { authorizeUrl = url; } }, tokenFetch as any);
    const started = await auth.startLogin();
    expect(started.authorizeUrl).toBe(authorizeUrl);
    const authorize = new URL(authorizeUrl);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "single-use-code"); callback.searchParams.set("state", started.state);
    const result = await fetch(callback);
    expect(result.status).toBe(200);
    expect((await auth.getAccessToken()).token).toBe("access-secret");
    expect(secrets.get("refresh-token")).toBe("refresh-secret");
  });
});
