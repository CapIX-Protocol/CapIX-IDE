import { describe, expect, it, vi } from "vitest";
import { CapixMainBroker } from "../../../src/main/capix-broker";
import { CAPIX_BROKER_CHANNEL, parseRendererMessage, registerCapixIpc } from "../../../src/main/capix-ipc-registration";
import { CapixChatChannels } from "../../../src/vs/workbench/contrib/capix-ai/index";
import { CapixNativePkceAuth } from "../../../src/main/capix-native-auth";

describe("native Capix runtime", () => {
  it("rejects untyped and malformed IPC before broker dispatch", () => {
    expect(() => parseRendererMessage({ type: "fetch", url: "https://evil.example" })).toThrow();
    expect(() => parseRendererMessage({ type: "auth:login:callback", code: "", state: "x" })).toThrow();
  });

  it("registers all versioned Electron channels and validates sender origin", async () => {
    const handlers = new Map<string, (event: any, input: unknown) => Promise<unknown>>();
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((channel: string, fn: any) => { handlers.set(channel, fn); }) };
    const sdk = { catalog: { listModels: vi.fn().mockResolvedValue([{ id: "model-1" }]) } as any };
    const auth = { startLogin: vi.fn(), completeLogin: vi.fn(), logout: vi.fn() };
    const dispose = registerCapixIpc(ipc, new CapixMainBroker({ sdk, auth }));
    expect(ipc.handle).toHaveBeenCalledWith(CAPIX_BROKER_CHANNEL, expect.any(Function));
    for (const ch of Object.values(CapixChatChannels)) {
      if (ch === CapixChatChannels.onStreamEvent) continue;
      expect(ipc.handle).toHaveBeenCalledWith(ch, expect.any(Function));
    }
    const brokerListener = handlers.get(CAPIX_BROKER_CHANNEL)!;
    await expect(brokerListener({ sender: { id: 7, getURL: () => "https://evil.example/workbench" } }, { type: "catalog:models" })).rejects.toThrow(/untrusted origin/);
    await expect(brokerListener({ sender: { id: 7, getURL: () => "vscode-file://vscode-app/out/vs/workbench/workbench.html" } }, { type: "catalog:models" })).resolves.toEqual([{ id: "model-1" }]);
    await expect(brokerListener({ sender: { id: 7, getURL: () => "https://www.capix.network/workbench" } }, { type: "catalog:models" })).resolves.toEqual([{ id: "model-1" }]);
    dispose();
    expect(ipc.removeHandler).toHaveBeenCalledWith(CAPIX_BROKER_CHANNEL);
    for (const ch of Object.values(CapixChatChannels)) {
      if (ch === CapixChatChannels.onStreamEvent) continue;
      expect(ipc.removeHandler).toHaveBeenCalledWith(ch);
    }
  });

  it("startSession creates a chat session and streamMessage delegates to broker inference:stream", async () => {
    const handlers = new Map<string, (event: any, input: unknown) => Promise<unknown>>();
    const sentEvents: Array<{ channel: string; args: unknown[] }> = [];
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((channel: string, fn: any) => { handlers.set(channel, fn); }) };
    const sdk = {
      catalog: { listModels: vi.fn().mockResolvedValue([]) } as any,
      inference: { stream: vi.fn().mockResolvedValue([]), cancel: vi.fn().mockResolvedValue(undefined) } as any,
    };
    const auth = { startLogin: vi.fn(), completeLogin: vi.fn(), logout: vi.fn() };
    registerCapixIpc(ipc, new CapixMainBroker({ sdk, auth }));

    const startHandler = handlers.get(CapixChatChannels.startSession)!;
    const session = await startHandler(
      { sender: { id: 1, getURL: () => "vscode-file://vscode-app/out/vs/workbench/workbench.html" } },
      { modelId: "capix/sonnet", projectId: "proj-1" },
    );
    expect(session).toMatchObject({ modelId: "capix/sonnet", messages: [] });
    expect(session.id).toMatch(/^chat-/);

    const streamHandler = handlers.get(CapixChatChannels.streamMessage)!;
    const streamResult = await streamHandler(
      {
        sender: {
          id: 1,
          getURL: () => "vscode-file://vscode-app/out/vs/workbench/workbench.html",
          send: (channel: string, ...args: unknown[]) => { sentEvents.push({ channel, args }); },
        },
      },
      { sessionId: session.id, message: "hello" },
    );
    expect(streamResult.streamHandle).toMatch(/^inference-/);
    expect(sdk.inference.stream).toHaveBeenCalledTimes(1);

    const cancelHandler = handlers.get(CapixChatChannels.cancel)!;
    await cancelHandler(
      { sender: { id: 1, getURL: () => "vscode-file://vscode-app/out/vs/workbench/workbench.html" } },
      { sessionId: streamResult.streamHandle },
    );
    expect(sdk.inference.cancel).toHaveBeenCalledWith(streamResult.streamHandle, expect.any(AbortSignal));
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
