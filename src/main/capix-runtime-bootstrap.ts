import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { randomUUID } from "node:crypto";
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

	async function sendJson(method: string, pathname: string, body?: unknown, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<any> {
		const token = await auth.getAccessToken();
		const url = new URL(pathname, origin);
		const headers: Record<string, string> = { authorization: `Bearer ${token.token}`, accept: "application/json", ...extraHeaders };
		if (body !== undefined) { headers["content-type"] = "application/json"; headers["idempotency-key"] = randomUUID(); }
		const response = await fetchImpl(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
		const text = await response.text();
		if (!response.ok) { let detail = text; try { detail = JSON.parse(text)?.error ?? JSON.parse(text)?.title ?? text; } catch {} throw new Error(`Capix API ${response.status}: ${detail || "request failed"}`); }
		if (!text) return undefined;
		try { return JSON.parse(text); } catch { return undefined; }
	}

	const postJson = (pathname: string, body?: unknown, signal?: AbortSignal) => sendJson("POST", pathname, body, signal);

	async function* streamSse(pathname: string, signal?: AbortSignal): AsyncGenerator<unknown> {
		const token = await auth.getAccessToken();
		const response = await fetchImpl(new URL(pathname, origin), { headers: { authorization: `Bearer ${token.token}`, accept: "text/event-stream" }, signal });
		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			let detail = text; try { detail = JSON.parse(text)?.error ?? text; } catch {}
			throw new Error(`Capix API ${response.status}: ${detail || "stream request failed"}`);
		}
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
		quote: { create: (input: unknown, signal?: AbortSignal) => postJson("/api/v1/quotes", input, signal) },
		deployment: {
			create: (input: unknown, signal?: AbortSignal) => postJson("/api/v1/deployments", input, signal),
			get: (id: string, signal?: AbortSignal) => getJson(`/api/v1/deployments/${encodeURIComponent(id)}`, signal),
			list: (cursor?: string, signal?: AbortSignal) => getJson(`/api/v1/deployments?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, signal),
			setDesired: async (id: string, desired: unknown, signal?: AbortSignal) => {
				// The control plane requires If-Match with the current version.
				const current = await getJson(`/api/v1/deployments/${encodeURIComponent(id)}`, signal);
				const version = Number(current?.version ?? current?.data?.version ?? 0);
				const desiredState = typeof desired === "string" ? desired : (desired as { desiredState?: unknown })?.desiredState;
				return sendJson("PATCH", `/api/v1/deployments/${encodeURIComponent(id)}`, { desiredState }, signal, { "if-match": String(version) });
			},
			delete: (id: string, signal?: AbortSignal) => sendJson("DELETE", `/api/v1/deployments/${encodeURIComponent(id)}`, undefined, signal),
		},
		operation: {
			subscribe: (id: string, signal?: AbortSignal) => Promise.resolve(streamSse(`/api/v1/operations/${encodeURIComponent(id)}/events`, signal)),
			cancel: (id: string, signal?: AbortSignal) => postJson(`/api/v1/operations/${encodeURIComponent(id)}`, {}, signal),
		},
		inference: {
			stream: (input: unknown, signal?: AbortSignal) => Promise.resolve(streamInference(input, signal)),
			// No server-side cancel route exists: the control plane finalizes the
			// stream on client disconnect, which the broker drives through its
			// AbortController before delegating here.
			cancel: () => Promise.resolve(undefined),
		},
		billing: {
			getBalance: (signal?: AbortSignal) => getJson("/api/v1/billing", signal),
			// The control plane has no separate invoice ledger: finalized route
			// receipts are the bill of record. Derive invoice rows from settled
			// debit entries so the billing surface shows real customer data.
			listInvoices: async (signal?: AbortSignal) => {
				const billing = await getJson("/api/v1/billing", signal);
				const entries = Array.isArray(billing?.transactions) ? billing.transactions : [];
				const invoices = entries
					.filter((row: any) => row && (row.postingType ?? row.posting_type) === "debit" && (row.asset === "USDC" || row.asset === "USD-credit"))
					.map((row: any, index: number) => {
						const occurredAt = Date.parse(row.createdAt ?? row.created_at ?? "") || 0;
						return {
							id: String(row.id ?? row.entryId ?? `inv_${index}`),
							number: String(row.receiptId ?? row.reference ?? row.id ?? `inv_${index}`),
							periodStart: occurredAt,
							periodEnd: occurredAt,
							totalMinor: String(row.amount ?? "0"),
							currency: "USD",
							status: "paid",
						};
					});
				return { invoices };
			},
		},
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
