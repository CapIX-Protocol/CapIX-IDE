"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevTokenManager = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("./logger");
class DevTokenManager {
    client;
    sessionTurns = 0;
    mintedReasons = new Set(); // dedupe per session
    constructor(client) {
        this.client = client;
    }
    /** Call when a git commit is detected (e.g. via SCm state change). */
    async onCommit(commitSha, repoHash) {
        const key = `commit-${commitSha || Date.now()}`;
        if (this.mintedReasons.has(key))
            return;
        this.mintedReasons.add(key);
        try {
            const res = await this.client.mintDevTokens("commit", {
                commitSha,
                repoHash,
                toolUsed: "capix-ide",
            });
            if (res.ok) {
                vscode.window.showInformationMessage(`◆ Capix Dev Token: +${res.mint?.amount || 1} DEV minted for committing with Capix IDE.`);
            }
        }
        catch (err) {
            logger_1.logger.error("DevTokenManager.onCommit failed", { error: String(err) });
        }
    }
    /** Call when a deploy succeeds (agent, serverless, LLM, VPS). */
    async onDeploy(sessionId) {
        try {
            const res = await this.client.mintDevTokens("deploy", {
                sessionId,
                toolUsed: "capix-ide",
            });
            if (res.ok) {
                vscode.window.showInformationMessage(`◆ Capix Dev Token: +${res.mint?.amount || 5} DEV minted for deploying from Capix IDE.`);
            }
        }
        catch (err) {
            logger_1.logger.error("DevTokenManager.onDeploy failed", { error: String(err) });
        }
    }
    /** Call on each chat turn. Mints at 50 turns. */
    onChatTurn() {
        this.sessionTurns++;
        if (this.sessionTurns === 50) {
            this.mintSessionComplete();
        }
    }
    /** Call when a Covenant decision is recorded. */
    async onDecision() {
        try {
            const res = await this.client.mintDevTokens("decision", { toolUsed: "capix-ide" });
            if (res.ok) {
                vscode.window.showInformationMessage(`◆ Capix Dev Token: +${res.mint?.amount || 2} DEV minted for recording a decision.`);
            }
        }
        catch (err) {
            logger_1.logger.error("DevTokenManager.onDecision failed", { error: String(err) });
        }
    }
    async mintSessionComplete() {
        const key = "session-complete";
        if (this.mintedReasons.has(key))
            return;
        this.mintedReasons.add(key);
        try {
            const res = await this.client.mintDevTokens("session-complete", { toolUsed: "capix-ide" });
            if (res.ok) {
                vscode.window.showInformationMessage(`◆ Capix Dev Token: +${res.mint?.amount || 10} DEV minted for completing a productive session!`);
            }
        }
        catch (err) {
            logger_1.logger.error("DevTokenManager.mintSessionComplete failed", { error: String(err) });
        }
    }
    /** Get the user's DEV token balance for display in the Profile panel. */
    async getBalance() {
        try {
            const res = await this.client.getDevTokenBalance();
            if (res.ok) {
                return { balance: res.balance || 0, totalEarned: res.totalEarned || 0 };
            }
        }
        catch (err) {
            logger_1.logger.error("DevTokenManager.getBalance failed", { error: String(err) });
        }
        return { balance: 0, totalEarned: 0 };
    }
}
exports.DevTokenManager = DevTokenManager;
//# sourceMappingURL=devTokenManager.js.map