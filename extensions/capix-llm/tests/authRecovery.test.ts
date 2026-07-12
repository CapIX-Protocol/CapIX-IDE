import { describe, expect, it, vi } from "vitest";
import { resetSessionAndSignIn } from "../src/authRecovery";

describe("resetSessionAndSignIn", () => {
  it("removes stale auth, publishes signed-out state, then starts fresh PKCE", async () => {
    const order: string[] = [];
    const client = { resetOAuthSession: vi.fn(async () => { order.push("reset"); }) };
    const notifySignedOut = vi.fn(async () => { order.push("signed-out"); });
    const startPkce = vi.fn(async () => { order.push("pkce"); });

    await resetSessionAndSignIn(client as never, notifySignedOut, startPkce);

    expect(order).toEqual(["reset", "signed-out", "pkce"]);
    expect(startPkce).toHaveBeenCalledOnce();
  });

  it("still starts fresh PKCE when an optional signed-out view cannot refresh", async () => {
    const client = { resetOAuthSession: vi.fn().mockResolvedValue(undefined) };
    const startPkce = vi.fn().mockResolvedValue(undefined);

    await expect(resetSessionAndSignIn(
      client as never,
      vi.fn().mockRejectedValue(new Error("view unavailable")),
      startPkce,
    )).resolves.toBeUndefined();

    expect(startPkce).toHaveBeenCalledOnce();
  });
});
