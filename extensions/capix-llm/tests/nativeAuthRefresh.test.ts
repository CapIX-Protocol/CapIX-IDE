import { describe, it, expect, vi } from "vitest";
import { CapixNativePkceAuth } from "../../../src/main/capix-native-auth";

function createHarness(tokenResponses: Response[] | ((url: unknown, init: any) => Promise<Response>)) {
  const secrets = new Map<string, string>([["refresh-token", "cpxr_refresh_initial"]]);
  const store = {
    get: vi.fn(async (_service: string, account: string) => secrets.get(account) ?? null),
    set: vi.fn(async (_service: string, account: string, value: string) => { secrets.set(account, value); }),
    delete: vi.fn(async (_service: string, account: string) => { secrets.delete(account); }),
  };
  const queue = Array.isArray(tokenResponses) ? [...tokenResponses] : null;
  const fetchMock = vi.fn(async (url: unknown, init: any) => {
    if (queue) {
      const next = queue.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    }
    return (tokenResponses as (url: unknown, init: any) => Promise<Response>)(url, init);
  });
  const auth = new CapixNativePkceAuth(
    { baseUrl: "https://www.capix.network", authorizePath: "/oauth/authorize", tokenPath: "/oauth/token", revokePath: "/oauth/revoke", clientId: "capix-ide", scope: "openid account catalog" },
    store,
    { openExternal: async () => {} },
    fetchMock as any,
  );
  return { auth, secrets, store, fetchMock };
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

describe("CapixNativePkceAuth refresh-token grant", () => {
  it("exchanges the stored refresh token instead of demanding a new login", async () => {
    const { auth, fetchMock } = createHarness([
      jsonResponse({ access_token: "cpxs_fresh", refresh_token: "cpxr_refresh_rotated", expires_in: 300, account_id: "acct-1", project_id: "proj-1" }),
    ]);

    const result = await auth.getAccessToken();
    expect(result.token).toBe("cpxs_fresh");
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe("https://www.capix.network/oauth/token");
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=cpxr_refresh_initial");
  });

  it("persists the rotated refresh token and reuses the fresh access token", async () => {
    const { auth, secrets, fetchMock } = createHarness([
      jsonResponse({ access_token: "cpxs_fresh", refresh_token: "cpxr_refresh_rotated", expires_in: 300 }),
    ]);

    await auth.getAccessToken();
    expect(secrets.get("refresh-token")).toBe("cpxr_refresh_rotated");

    // Second read stays in memory — no extra grant while the token is valid.
    const again = await auth.getAccessToken();
    expect(again.token).toBe("cpxs_fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares a single in-flight refresh across concurrent callers", async () => {
    let resolveGrant!: (response: Response) => void;
    const { auth, fetchMock } = createHarness(() => new Promise<Response>((resolve) => { resolveGrant = resolve; }));

    const first = auth.getAccessToken();
    const second = auth.getAccessToken();
    // The grant fetch starts after the credential-store read (a microtask).
    await vi.waitFor(() => expect(typeof resolveGrant).toBe("function"));
    resolveGrant(jsonResponse({ access_token: "cpxs_single_flight", refresh_token: "cpxr_rotated", expires_in: 300 }));

    await expect(first).resolves.toMatchObject({ token: "cpxs_single_flight" });
    await expect(second).resolves.toMatchObject({ token: "cpxs_single_flight" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the local session when the grant is definitively rejected", async () => {
    const { auth, secrets } = createHarness([jsonResponse({ error: "invalid_grant" }, 400)]);

    await expect(auth.getAccessToken()).rejects.toThrow(/Capix authentication required/);
    expect(secrets.has("refresh-token")).toBe(false);
  });

  it("keeps the stored grant after a transient network failure", async () => {
    const { auth, secrets } = createHarness([jsonResponse({ error: "boom" }, 500)]);

    await expect(auth.getAccessToken()).rejects.toThrow(/Capix authentication required/);
    expect(secrets.get("refresh-token")).toBe("cpxr_refresh_initial");
  });

  it("surfaces the provider error when the loopback callback carries one", async () => {
    const { auth } = createHarness([]);
    const started = await auth.startLogin();
    const callback = new URL(new URL(started.authorizeUrl).searchParams.get("redirect_uri")!);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("state", started.state);
    const response = await fetch(callback);
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Capix sign-in failed");
  });
});
