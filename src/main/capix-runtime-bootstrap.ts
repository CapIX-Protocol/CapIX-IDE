import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { CapixMainBroker, CapixNotImplementedError, type CapixSdkClient } from "./capix-broker.js";
import { createCapixDesktopInstanceGuard } from "./capix-desktop-instance.js";
import { registerCapixIpc } from "./capix-ipc-registration.js";
import { CapixNativePkceAuth, type SecureCredentialStore } from "./capix-native-auth.js";

interface CapixProductConfig {
	capixVersion?: string;
	capixControlPlaneOrigin?: string;
	capixOAuthAuthorizePath?: string;
	capixOAuthTokenPath?: string;
	capixOAuthRevokePath?: string;
}

const claimDesktopInstance = createCapixDesktopInstanceGuard();

/**
 * Keep every installed/build copy of CapixIDE on one Electron profile owner.
 * Running two bundle paths against the same userData directory can corrupt the
 * shared vscode-webview Service Worker database and leave every webview blank.
 */
export function claimCapixDesktopInstance(): boolean {
	return claimDesktopInstance(app, () => BrowserWindow.getAllWindows());
}

export function resolveControlPlaneOrigin(product: CapixProductConfig, env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.CAPIX_IDE_CONTROL_PLANE_ORIGIN || product.capixControlPlaneOrigin;
	if (!configured) throw new Error("Capix control-plane origin is missing from product configuration");
	const url = new URL(configured);
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Capix control-plane origin must be an HTTPS origin without credentials or paths");
	return url.origin;
}

class ElectronSafeCredentialStore implements SecureCredentialStore {
	private readonly directory = path.join(app.getPath("userData"), "capix-credentials");
	private file(service: string, account: string): string { return path.join(this.directory, `${encodeURIComponent(service)}.${encodeURIComponent(account)}.bin`); }
	async get(service: string, account: string): Promise<string | null> {
		try { const encrypted = await fs.readFile(this.file(service, account)); return safeStorage.decryptString(encrypted); } catch { return null; }
	}
	async set(service: string, account: string, secret: string): Promise<void> {
		if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		await fs.writeFile(this.file(service, account), safeStorage.encryptString(secret), { mode: 0o600 });
	}
	async delete(service: string, account: string): Promise<void> { try { await fs.unlink(this.file(service, account)); } catch (error: any) { if (error?.code !== "ENOENT") throw error; } }
}

function unsupported(name: string): any { return async () => { throw new CapixNotImplementedError(name); }; }

export function createControlPlaneSdk(origin: string, auth: CapixNativePkceAuth, fetchImpl: typeof fetch = fetch): CapixSdkClient {
	async function getJson(pathname: string, signal?: AbortSignal): Promise<any> {
		const token = await auth.getAccessToken();
		const url = new URL(pathname, origin);
		if (pathname === "/api/v1/models" && auth.getProjectId()) url.searchParams.set("projectId", auth.getProjectId()!);
		const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token.token}`, accept: "application/json" }, signal });
		const body = await response.json(); if (!response.ok) throw new Error(`Capix API ${response.status}: ${body?.error ?? body?.title ?? "request failed"}`); return body;
	}

	async function postJson(pathname: string, signal?: AbortSignal): Promise<any> {
		const token = await auth.getAccessToken();
		const url = new URL(pathname, origin);
		const response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token.token}`, accept: "application/json" }, signal });
		const text = await response.text();
		if (!response.ok) { let detail = text; try { detail = JSON.parse(text)?.error ?? text; } catch {} throw new Error(`Capix API ${response.status}: ${detail || "request failed"}`); }
		if (!text) return undefined;
		try { return JSON.parse(text); } catch { return undefined; }
	}

	async function* streamInference(input: unknown, signal?: AbortSignal): AsyncGenerator<unknown> {
		async function performRequest(token: string, isRetry: boolean): Promise<Response> {
			const url = new URL("/api/v1/inference/chat/completions", origin);
			const response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(input), signal });
			if (response.status === 401 && !isRetry) {
				const refreshed = await auth.getAccessToken();
				return performRequest(refreshed.token, true);
			}
			if (!response.ok || !response.body) {
				const text = await response.text().catch(() => "");
				let detail = text; try { detail = JSON.parse(text)?.error ?? text; } catch {}
				if (response.status === 402) throw new Error(`Capix API 402: insufficient funds${detail ? ` — ${detail}` : ""}`);
				if (response.status === 429) throw new Error(`Capix API 429: rate limited${detail ? ` — ${detail}` : ""}`);
				throw new Error(`Capix API ${response.status}: ${detail || "inference request failed"}`);
			}
			return response;
		}

		const token = await auth.getAccessToken();
		const response = await performRequest(token.token, false);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let dataLines: string[] = [];
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newlineIdx: number;
				while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
					buffer = buffer.slice(newlineIdx + 1);
					if (line === "") {
						if (dataLines.length > 0) {
							const raw = dataLines.join("\n");
							let data: unknown = raw;
							try { data = JSON.parse(raw); } catch {}
							yield data;
						}
						dataLines = [];
						continue;
					}
					if (line.startsWith(":")) continue;
					if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
				}
			}
			if (dataLines.length > 0) {
				const raw = dataLines.join("\n");
				let data: unknown = raw;
				try { data = JSON.parse(raw); } catch {}
				yield data;
			}
		} finally {
			reader.releaseLock();
		}
	}

	return {
		account: { get: () => getJson("/api/v1/account") },
		catalog: { listModels: async () => (await getJson("/api/v1/models")).models },
		quote: { create: unsupported("quote creation is not enabled in the IDE native runtime") },
		deployment: { create: unsupported("deployment creation is not enabled in the IDE native runtime"), get: unsupported("deployment access is not enabled in the IDE native runtime"), list: unsupported("deployment listing is not enabled in the IDE native runtime"), setDesired: unsupported("deployment lifecycle is not enabled in the IDE native runtime"), delete: unsupported("deployment deletion is not enabled in the IDE native runtime") },
		operation: { subscribe: unsupported("operation streaming is not enabled in the IDE native runtime"), cancel: unsupported("operation cancellation is not enabled in the IDE native runtime") },
		inference: { stream: (input: unknown, signal?: AbortSignal) => Promise.resolve(streamInference(input, signal)), cancel: (sessionId: string, signal?: AbortSignal) => postJson(`/api/v1/inference/${encodeURIComponent(sessionId)}/cancel`, signal) },
		billing: { getBalance: (signal?: AbortSignal) => getJson("/api/v1/billing", signal), listInvoices: unsupported("billing is not enabled in the IDE native runtime") },
		receipt: { get: (id: string, signal?: AbortSignal) => getJson(`/api/v1/route-receipts/${encodeURIComponent(id)}`, signal) },
		workspace: { openSession: unsupported("remote workspace transport is unavailable"), openPort: unsupported("remote workspace transport is unavailable"), closeSession: unsupported("remote workspace transport is unavailable") },
	};
}

export function startCapixNativeRuntime(rawProduct: unknown): () => void {
	if (!claimCapixDesktopInstance()) return () => undefined;
	const product = rawProduct as CapixProductConfig;
	const origin = resolveControlPlaneOrigin(product);
	const auth = new CapixNativePkceAuth({ baseUrl: origin, authorizePath: product.capixOAuthAuthorizePath || "/oauth/authorize", tokenPath: product.capixOAuthTokenPath || "/oauth/token", revokePath: product.capixOAuthRevokePath || "/oauth/revoke", clientId: "capix-ide", scope: "openid account catalog" }, new ElectronSafeCredentialStore(), { openExternal: async url => { await shell.openExternal(url); } });
	const broker = new CapixMainBroker({ auth, sdk: createControlPlaneSdk(origin, auth) }, product.capixVersion);
	const unregister = registerCapixIpc(ipcMain, broker);
	const shutdown = () => { unregister(); void broker.shutdown(); };
	app.once("before-quit", shutdown);
	return shutdown;
}
