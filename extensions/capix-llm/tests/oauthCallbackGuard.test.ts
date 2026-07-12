import { describe, expect, it } from "vitest";
import { OAuthCallbackGuard } from "../src/oauthCallbackGuard";

describe("OAuthCallbackGuard", () => {
  it("ignores favicon and unrelated requests before accepting the exact callback", () => {
    const guard = new OAuthCallbackGuard("expected-state");
    expect(guard.inspect("/favicon.ico")).toEqual({ kind: "ignore" });
    expect(guard.inspect("/health")).toEqual({ kind: "ignore" });
    expect(guard.inspect("/oauth/callback?code=fresh&state=expected-state")).toEqual({ kind: "exchange", code: "fresh" });
  });

  it("rejects a mismatched stale callback without consuming the valid callback", () => {
    const guard = new OAuthCallbackGuard("new-state");
    expect(guard.inspect("/oauth/callback?code=stale&state=old-state").kind).toBe("invalid");
    expect(guard.inspect("/oauth/callback?code=fresh&state=new-state")).toEqual({ kind: "exchange", code: "fresh" });
  });

  it("single-consumes an exact redirect and rejects duplicate valid callbacks", () => {
    const guard = new OAuthCallbackGuard("state");
    expect(guard.inspect("/oauth/callback?code=one&state=state")).toEqual({ kind: "exchange", code: "one" });
    expect(guard.inspect("/oauth/callback?code=two&state=state")).toEqual({ kind: "duplicate" });
    guard.exchangeSucceeded();
    expect(guard.inspect("/oauth/callback?code=three&state=state")).toEqual({ kind: "duplicate" });
  });

  it("allows an exact callback retry only when token exchange failed", () => {
    const guard = new OAuthCallbackGuard("state");
    expect(guard.inspect("/oauth/callback?code=first&state=state").kind).toBe("exchange");
    guard.exchangeFailed();
    expect(guard.inspect("/oauth/callback?code=second&state=state")).toEqual({ kind: "exchange", code: "second" });
  });
});
