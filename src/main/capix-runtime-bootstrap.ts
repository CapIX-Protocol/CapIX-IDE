import { app, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { CapixMainBroker, CapixNotImplementedError, type CapixSdkClient } from "./capix-broker.js";
import { registerCapixIpc } from "./capix-ipc-registration.js";
import { CapixNativePkceAuth, type SecureCredentialStore } from "./capix-native-auth.js";

interface CapixProductConfig {
	capixVersion?: string;
	capixControlPlaneOrigin?: string;
	capixOAuthAuthorizePath?: string;
	capixOAuthTokenPath?: string;
	capixOAuthRevokePath?: string;
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
	async function getJson(pathname: string): Promise<any> {
		const token = await auth.getAccessToken();
		const url = new URL(pathname, origin);
		if (pathname === "/api/v1/models" && auth.getProjectId()) url.searchParams.set("projectId", auth.getProjectId()!);
		const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token.token}`, accept: "application/json" } });
		const body = await response.json(); if (!response.ok) throw new Error(`Capix API ${response.status}: ${body?.error ?? body?.title ?? "request failed"}`); return body;
	}
	return {
		account: { get: () => getJson("/api/v1/account") },
		catalog: { listModels: async () => (await getJson("/api/v1/models")).models },
		quote: { create: unsupported("quote creation is not enabled in the IDE native runtime") },
		deployment: { create: unsupported("deployment creation is not enabled in the IDE native runtime"), get: unsupported("deployment access is not enabled in the IDE native runtime"), list: unsupported("deployment listing is not enabled in the IDE native runtime"), setDesired: unsupported("deployment lifecycle is not enabled in the IDE native runtime"), delete: unsupported("deployment deletion is not enabled in the IDE native runtime") },
		operation: { subscribe: unsupported("operation streaming is not enabled in the IDE native runtime"), cancel: unsupported("operation cancellation is not enabled in the IDE native runtime") },
		inference: { stream: unsupported("inference is not enabled in the IDE native runtime"), cancel: unsupported("inference cancellation is not enabled in the IDE native runtime") },
		billing: { getBalance: unsupported("billing is not enabled in the IDE native runtime"), listInvoices: unsupported("billing is not enabled in the IDE native runtime") },
		receipt: { get: unsupported("receipts are not enabled in the IDE native runtime") },
		workspace: { openSession: unsupported("remote workspace transport is unavailable"), openPort: unsupported("remote workspace transport is unavailable"), closeSession: unsupported("remote workspace transport is unavailable") },
	};
}

export function startCapixNativeRuntime(rawProduct: unknown): () => void {
	const product = rawProduct as CapixProductConfig;
	const origin = resolveControlPlaneOrigin(product);
	const auth = new CapixNativePkceAuth({ baseUrl: origin, authorizePath: product.capixOAuthAuthorizePath || "/oauth/authorize", tokenPath: product.capixOAuthTokenPath || "/oauth/token", revokePath: product.capixOAuthRevokePath || "/oauth/revoke", clientId: "capix-ide", scope: "openid account catalog" }, new ElectronSafeCredentialStore(), { openExternal: async url => { await shell.openExternal(url); } });
	const broker = new CapixMainBroker({ auth, sdk: createControlPlaneSdk(origin, auth) }, product.capixVersion);
	const unregister = registerCapixIpc(ipcMain, broker);
	const shutdown = () => { unregister(); void broker.shutdown(); };
	app.once("before-quit", shutdown);
	return shutdown;
}
