/**
 * CLI Token Broker — lets the IDE borrow the Capix Code CLI's identity when
 * the IDE has no OAuth grant of its own.
 *
 * The CLI is the native credential broker for Capix clients: the rotating
 * refresh token stays inside the OS keychain behind the CLI binary, and this
 * adapter only ever holds short-lived access tokens in memory. No refresh
 * material is read, written, or logged by the IDE.
 *
 * Resolution order for the CLI binary:
 *   1. `CAPIX_CODE_BIN` env var (explicit override)
 *   2. `capix-code` on PATH (npm/global install)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

/** Access tokens are short-lived; refresh well before the server-side expiry. */
const TOKEN_TTL_MS = 45 * 60 * 1000;
/** Don't hammer the CLI when the user is simply signed out. */
const FAILURE_BACKOFF_MS = 30 * 1000;
const EXEC_TIMEOUT_MS = 15 * 1000;

type TokenRunner = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export class CliTokenBroker {
  private cachedToken: string | null = null;
  private cachedAt = 0;
  private lastFailureAt = 0;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly run: TokenRunner = async (bin, args) => {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: EXEC_TIMEOUT_MS,
        env: { ...process.env },
        maxBuffer: 64 * 1024,
      });
      return { stdout, stderr };
    },
    private readonly bin: string = (
      process.env.CAPIX_CODE_BIN || "capix-code"
    ).trim() || "capix-code",
  ) {}

  /**
   * A valid access token from the CLI's keychain-backed session.
   * Throws when the CLI is missing or the user is signed out there.
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() - this.cachedAt < TOKEN_TTL_MS) {
      return this.cachedToken;
    }
    if (Date.now() - this.lastFailureAt < FAILURE_BACKOFF_MS) {
      throw new Error("Not signed in to Capix Code.");
    }
    // Single-flight: concurrent callers share one CLI invocation so the
    // rotating refresh token is never raced by parallel refreshes.
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Drop the cached token (e.g. after a 401) so the next call re-fetches. */
  invalidate(): void {
    this.cachedToken = null;
    this.cachedAt = 0;
  }

  private async fetchToken(): Promise<string> {
    try {
      const { stdout } = await this.run(this.bin, ["auth", "token"]);
      const parsed = JSON.parse(stdout.trim()) as { access_token?: unknown };
      if (typeof parsed.access_token !== "string" || !parsed.access_token) {
        throw new Error("malformed token response");
      }
      this.cachedToken = parsed.access_token;
      this.cachedAt = Date.now();
      logger.info("Capix auth: borrowed session from Capix Code CLI");
      return this.cachedToken;
    } catch (error) {
      this.lastFailureAt = Date.now();
      logger.info("Capix auth: CLI token broker unavailable", {
        error: String(error).slice(0, 200),
      });
      throw new Error("Not signed in to Capix Code.");
    }
  }
}
