import type { CapixClient } from "./apiClient";

/** Reset stale OAuth state, publish signed-out state, then start fresh PKCE. */
export async function resetSessionAndSignIn(
  client: CapixClient,
  notifySignedOut: () => Promise<void>,
  startPkce: () => Promise<void>,
): Promise<void> {
  await client.resetOAuthSession();
  // A broken optional view must never strand the customer after credentials
  // have been cleared: fresh browser PKCE is the recovery path.
  await notifySignedOut().catch(() => undefined);
  await startPkce();
}
