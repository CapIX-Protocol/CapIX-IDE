import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface SecureCredentialStore {
	get(service: string, account: string): Promise<string | null>;
	set(service: string, account: string, secret: string): Promise<void>;
	delete(service: string, account: string): Promise<void>;
}

export interface SystemBrowser {
	openExternal(url: string): Promise<void>;
}

export interface NativeAuthConfig {
	baseUrl: string;
	authorizePath: string;
	tokenPath: string;
	revokePath: string;
	clientId: string;
	scope: string;
	callbackTimeoutMs?: number;
}

interface PendingLogin { state: string; verifier: string; redirectUri: string; server: Server; timeout: ReturnType<typeof setTimeout> }
interface TokenPayload { access_token: string; refresh_token?: string; expires_in?: number; account_id?: string; project_id?: string }

function random(bytes: number): string { return randomBytes(bytes).toString("base64url"); }
function challenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }

export class CapixNativePkceAuth {
	private pending?: PendingLogin;
	private accessToken?: { value: string; expiresAt: number };
	private projectId?: string;
	private readonly service = "network.capix.ide";

	constructor(private readonly config: NativeAuthConfig, private readonly credentials: SecureCredentialStore, private readonly browser: SystemBrowser, private readonly fetchImpl: typeof fetch = fetch) {
		for (const path of [config.authorizePath, config.tokenPath, config.revokePath]) if (!path.startsWith("/")) throw new Error("Auth endpoint paths must be absolute");
		if (new URL(config.baseUrl).protocol !== "https:") throw new Error("Native auth requires an HTTPS control-plane origin");
	}

	async startLogin(): Promise<{ authorizeUrl: string; state: string }> {
		this.cancelPending();
		const verifier = random(48); const state = random(32); const nonce = random(24);
		const server = createServer((request, response) => {
			void this.acceptLoopback(request.url, response).catch(() => {
				response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" }); response.end("Capix sign-in failed. Return to the IDE.");
			});
		});
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
		const address = server.address();
		if (!address || typeof address === "string") { server.close(); throw new Error("Unable to bind PKCE loopback callback"); }
		const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
		const timeout = setTimeout(() => this.cancelPending(), this.config.callbackTimeoutMs ?? 120_000);
		this.pending = { state, verifier, redirectUri, server, timeout };
		const url = new URL(this.config.authorizePath, this.config.baseUrl);
		for (const [key, value] of Object.entries({ response_type: "code", client_id: this.config.clientId, redirect_uri: redirectUri, scope: this.config.scope, code_challenge: challenge(verifier), code_challenge_method: "S256", state, nonce })) url.searchParams.set(key, value);
		await this.browser.openExternal(url.toString());
		return { authorizeUrl: url.toString(), state };
	}

	async completeLogin(code: string, state: string): Promise<{ status: "authenticated"; expiresAt: number; accountId?: string; projectId?: string }> {
		const pending = this.pending;
		if (!pending || state !== pending.state) throw new Error("PKCE state mismatch or expired login");
		const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, client_id: this.config.clientId });
		const response = await this.fetchImpl(new URL(this.config.tokenPath, this.config.baseUrl), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
		const payload = await response.json() as Partial<TokenPayload> & { error?: string };
		if (!response.ok || !payload.access_token) throw new Error(`Token exchange failed: ${payload.error ?? response.status}`);
		const expiresAt = Date.now() + Math.max(0, payload.expires_in ?? 300) * 1000;
		this.accessToken = { value: payload.access_token, expiresAt };
		this.projectId = payload.project_id;
		if (payload.refresh_token) await this.credentials.set(this.service, "refresh-token", payload.refresh_token);
		this.cancelPending();
		return { status: "authenticated", expiresAt, ...(payload.account_id ? { accountId: payload.account_id } : {}), ...(payload.project_id ? { projectId: payload.project_id } : {}) };
	}

	async getAccessToken(): Promise<{ token: string; expiresAt: number }> {
		if (!this.accessToken || this.accessToken.expiresAt <= Date.now()) throw new Error("Capix authentication required");
		return { token: this.accessToken.value, expiresAt: this.accessToken.expiresAt };
	}
	getProjectId(): string | undefined { return this.projectId; }

	async logout(): Promise<void> {
		const refreshToken = await this.credentials.get(this.service, "refresh-token");
		this.accessToken = undefined; this.projectId = undefined; this.cancelPending();
		if (refreshToken) {
			try { await this.fetchImpl(new URL(this.config.revokePath, this.config.baseUrl), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken, client_id: this.config.clientId }) }); } finally { await this.credentials.delete(this.service, "refresh-token"); }
		}
	}

	private async acceptLoopback(rawUrl: string | undefined, response: import("node:http").ServerResponse): Promise<void> {
		const pending = this.pending; if (!pending || !rawUrl) throw new Error("No pending login");
		const url = new URL(rawUrl, pending.redirectUri);
		if (url.pathname !== "/oauth/callback" || (!url.searchParams.get("code") && !url.searchParams.get("error"))) {
			response.writeHead(204, { "content-type": "text/plain" }); response.end(); return;
		}
		const code = url.searchParams.get("code"); const state = url.searchParams.get("state");
		if (!code || !state) throw new Error("Missing authorization callback parameters");
		await this.completeLogin(code, state);
		response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }); response.end("Capix sign-in complete. You can close this window.");
	}

	private cancelPending(): void { if (!this.pending) return; clearTimeout(this.pending.timeout); this.pending.server.close(); this.pending = undefined; }
}
