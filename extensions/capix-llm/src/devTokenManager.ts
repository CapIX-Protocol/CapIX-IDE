/**
 * Dev Token Manager — automatically mints DEV tokens to the user's wallet
 * when verifiable development happens in Capix IDE.
 *
 * Triggers:
 * - Git commit detected (via git extension integration)
 * - Successful deploy (agent, serverless, LLM)
 * - Productive session complete (>50 turns)
 * - Covenant decision recorded
 *
 * Tokens have no monetary value pre-mainnet — they're on-chain proof of
 * useful work. In the future, they'll be exchangeable for SOL or CPX.
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";

export class DevTokenManager {
  private sessionTurns = 0;
  private mintedReasons = new Set<string>(); // dedupe per session

  constructor(private client: CapixClient) {}

  /** Call when a git commit is detected (e.g. via SCm state change). */
  async onCommit(commitSha?: string, repoHash?: string): Promise<void> {
    const key = `commit-${commitSha || Date.now()}`;
    if (this.mintedReasons.has(key)) return;
    this.mintedReasons.add(key);

    try {
      const res = await this.client.mintDevTokens("commit", {
        commitSha,
        repoHash,
        toolUsed: "capix-ide",
      });
      if (res.ok) {
        vscode.window.showInformationMessage(
          `◆ Capix Dev Token: +${(res.mint as { amount?: number })?.amount || 1} DEV minted for committing with Capix IDE.`,
        );
      }
    } catch (err) { logger.error("DevTokenManager.onCommit failed", { error: String(err) }); }
  }

  /** Call when a deploy succeeds (agent, serverless, LLM, VPS). */
  async onDeploy(sessionId?: string): Promise<void> {
    try {
      const res = await this.client.mintDevTokens("deploy", {
        sessionId,
        toolUsed: "capix-ide",
      });
      if (res.ok) {
        vscode.window.showInformationMessage(
          `◆ Capix Dev Token: +${(res.mint as { amount?: number })?.amount || 5} DEV minted for deploying from Capix IDE.`,
        );
      }
    } catch (err) { logger.error("DevTokenManager.onDeploy failed", { error: String(err) }); }
  }

  /** Call on each chat turn. Mints at 50 turns. */
  onChatTurn(): void {
    this.sessionTurns++;
    if (this.sessionTurns === 50) {
      this.mintSessionComplete();
    }
  }

  /** Call when a Covenant decision is recorded. */
  async onDecision(): Promise<void> {
    try {
      const res = await this.client.mintDevTokens("decision", { toolUsed: "capix-ide" });
      if (res.ok) {
        vscode.window.showInformationMessage(
          `◆ Capix Dev Token: +${(res.mint as { amount?: number })?.amount || 2} DEV minted for recording a decision.`,
        );
      }
    } catch (err) { logger.error("DevTokenManager.onDecision failed", { error: String(err) }); }
  }

  private async mintSessionComplete(): Promise<void> {
    const key = "session-complete";
    if (this.mintedReasons.has(key)) return;
    this.mintedReasons.add(key);

    try {
      const res = await this.client.mintDevTokens("session-complete", { toolUsed: "capix-ide" });
      if (res.ok) {
        vscode.window.showInformationMessage(
          `◆ Capix Dev Token: +${(res.mint as { amount?: number })?.amount || 10} DEV minted for completing a productive session!`,
        );
      }
    } catch (err) { logger.error("DevTokenManager.mintSessionComplete failed", { error: String(err) }); }
  }

  /** Get the user's DEV token balance for display in the Profile panel. */
  async getBalance(): Promise<{ balance: number; totalEarned: number }> {
    try {
      const res = await this.client.getDevTokenBalance();
      if (res.ok) {
        return { balance: res.balance || 0, totalEarned: res.totalEarned || 0 };
      }
    } catch (err) { logger.error("DevTokenManager.getBalance failed", { error: String(err) }); }
    return { balance: 0, totalEarned: 0 };
  }
}
