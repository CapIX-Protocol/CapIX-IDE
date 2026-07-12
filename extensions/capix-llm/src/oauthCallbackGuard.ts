export type OAuthCallbackDecision =
  | { kind: "ignore" }
  | { kind: "invalid"; message: string }
  | { kind: "duplicate" }
  | { kind: "exchange"; code: string };

/** Keeps incidental/stale browser requests from consuming the PKCE listener. */
export class OAuthCallbackGuard {
  private exchanging = false;
  private completed = false;

  constructor(private readonly expectedState: string) {}

  inspect(requestUrl: string): OAuthCallbackDecision {
    const callback = new URL(requestUrl || "/", "http://127.0.0.1");
    if (callback.pathname !== "/oauth/callback") return { kind: "ignore" };
    if (this.completed || this.exchanging) return { kind: "duplicate" };
    const code = callback.searchParams.get("code");
    if (!code) return { kind: "invalid", message: "OAuth callback is missing its authorization code." };
    if (callback.searchParams.get("state") !== this.expectedState) {
      return { kind: "invalid", message: "OAuth callback state did not match. Continue with the newest sign-in tab." };
    }
    this.exchanging = true;
    return { kind: "exchange", code };
  }

  exchangeFailed(): void {
    this.exchanging = false;
  }

  exchangeSucceeded(): void {
    this.exchanging = false;
    this.completed = true;
  }
}
