/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/intelligenceClient - API client for the Capix Intelligence
 *  backend at https://www.capix.network/api/v1/. Uses fetch with the session
 *  token (cpx_session cookie) or OAuth bearer (cpxs_*) from VS Code
 *  SecretStorage, mirroring the capix-llm apiClient auth pattern (architecture
 *  S11.5; target ownership: extensions/capix-intelligence/).
 *
 *  Errors are parsed as RFC 7807 problem+json when the content-type matches;
 *  otherwise the raw status text is wrapped in ProblemDetails. The extension
 *  host never receives long-lived provider credentials — only the session/OAuth
 *  token is read from SecretStorage for the Authorization header.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import type {
	ProblemDetails,
	WriteMemoryRequest,
	WriteMemoryResponse,
	ListMemoryResponse,
	RetrieveMemoryRequest,
	RetrieveMemoryResponse,
	AnchorMemoryRequest,
	AnchorMemoryResponse,
	GraphQueryRequest,
	GraphData,
	RatifyCovenantRequest,
	RatifyCovenantResponse,
	ListCovenantsResponse,
	CheckPermissionRequest,
	CheckPermissionResponse,
	SpawnAgentRequest,
	SpawnAgentResponse,
	ListAgentsResponse,
	CompleteAgentRequest,
	RegisterSkillRequest,
	RegisterSkillResponse,
	ListSkillsResponse,
	CreatePlanRequest,
	CreatePlanResponse,
	ListPlansResponse,
	CreateCheckpointRequest,
	CreateCheckpointResponse,
	ListCheckpointsResponse,
	CreateReceiptRequest,
	CreateReceiptResponse,
	ListReceiptsResponse,
	ListHandoffsResponse,
	CreateRelationshipRequest,
	CreateRelationshipResponse,
	RecordHookEventRequest,
	RecordHookEventResponse,
	ListHookEventsResponse,
} from "./types.js";

/** A typed intelligence API error carrying the parsed RFC 7807 problem. */
export class IntelligenceApiError extends Error {
	readonly problem: ProblemDetails;

	constructor(
		public readonly status: number,
		problem: ProblemDetails,
	) {
		super(problem.detail ?? problem.title ?? `request_failed_${status}`);
		this.name = "IntelligenceApiError";
		this.problem = problem;
	}

	get capixCode(): string | undefined {
		return this.problem.capixCode ?? String(this.status);
	}

	get supportId(): string | undefined {
		return this.problem.supportId;
	}
}

export class IntelligenceAuthError extends IntelligenceApiError {
	constructor(supportId?: string) {
		super(401, {
			status: 401,
			title: "Not signed in to Capix.",
			supportId,
		});
		this.name = "IntelligenceAuthError";
	}
}

/** SecretStorage-like interface (decouples from vscode import in tests). */
export interface SecretStore {
	get(key: string): Promise<string | undefined>;
}

export class IntelligenceClient {
	static readonly PRODUCTION_BASE_URL = "https://www.capix.network";
	static readonly API_PREFIX = "/api/v1";

	private _sessionToken: string | null = null;
	private _secretStorage?: SecretStore;

	/** Wire up VS Code SecretStorage for secure (non-plaintext) token storage. */
	setSecretStorage(store: SecretStore): void {
		this._secretStorage = store;
	}

	get baseUrl(): string {
		return IntelligenceClient.PRODUCTION_BASE_URL;
	}

	get isConfigured(): boolean {
		return Boolean(this._sessionToken && this.isAuthToken(this._sessionToken));
	}

	async checkConfigured(): Promise<boolean> {
		const token = await this.getStoredToken();
		this._sessionToken = token;
		return this.isAuthToken(token);
	}

	private isAuthToken(token: string): boolean {
		return token.startsWith("cpxs_") || token.startsWith("cpx_session.");
	}

	private async getStoredToken(): Promise<string> {
		if (this._sessionToken) return this._sessionToken;
		if (this._secretStorage) {
			const stored = await this._secretStorage.get("capix.sessionToken");
			if (stored) {
				this._sessionToken = stored;
				return stored;
			}
		}
		return "";
	}

	private async getAuthHeaders(): Promise<Record<string, string>> {
		const token = await this.getStoredToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	private buildUrl(path: string): string {
		return `${this.baseUrl}${IntelligenceClient.API_PREFIX}${path}`;
	}

	private async request<T>(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<T> {
		const headers: Record<string, string> = {
			Accept: "application/json, application/problem+json",
			...(await this.getAuthHeaders()),
		};

		let init: RequestInit = { method, headers };
		if (body !== undefined && method === "POST") {
			headers["Content-Type"] = "application/json";
			headers["Idempotency-Key"] = randomUUID();
			init = { ...init, body: JSON.stringify(body) };
		}

		const url = this.buildUrl(path);
		const res = await fetch(url, init);
		return this.parseResponse<T>(res);
	}

	private async parseResponse<T>(res: Response): Promise<T> {
		const contentType = res.headers.get("content-type") ?? "";

		// RFC 7807 problem+json or any non-ok status
		if (contentType.includes("application/problem+json") || !res.ok) {
			const problem = await this.parseProblem(res, contentType);
			if (res.status === 401) {
				throw new IntelligenceAuthError(problem.supportId);
			}
			throw new IntelligenceApiError(res.status, problem);
		}

		// Empty 204
		if (res.status === 204 || contentType.length === 0) {
			return {} as T;
		}

		if (contentType.includes("application/json")) {
			return (await res.json()) as T;
		}

		// Fallback
		return (await res.text()) as unknown as T;
	}

	private async parseProblem(res: Response, contentType: string): Promise<ProblemDetails> {
		if (contentType.includes("json") || contentType.includes("problem+json")) {
			try {
				const data = (await res.json()) as Partial<ProblemDetails>;
				return {
					status: res.status,
					type: data.type ?? `https://capix.network/errors/${res.status}`,
					title: data.title ?? res.statusText,
					detail: data.detail,
					instance: data.instance ?? res.url ?? undefined,
					capixCode: data.capixCode,
					supportId: data.supportId,
					errors: data.errors,
				};
			} catch {
				// body was not valid JSON despite content-type
			}
		}
		const text = await res.text().catch(() => "");
		return {
			status: res.status,
			title: res.statusText || `HTTP ${res.status}`,
			detail: text || undefined,
		};
	}

	// ── Memory ────────────────────────────────────────────────────────────

	writeMemory(req: WriteMemoryRequest): Promise<WriteMemoryResponse> {
		return this.request("POST", "/memory", req);
	}

	listMemory(): Promise<ListMemoryResponse> {
		return this.request("GET", "/memory");
	}

	retrieveMemory(req: RetrieveMemoryRequest): Promise<RetrieveMemoryResponse> {
		return this.request("POST", "/memory/retrieve", req);
	}

	anchorMemory(req: AnchorMemoryRequest): Promise<AnchorMemoryResponse> {
		return this.request("POST", "/memory/anchor", req);
	}

	// ── Graph ─────────────────────────────────────────────────────────────

	queryGraph(req: GraphQueryRequest): Promise<GraphData> {
		return this.request("POST", "/graph", req);
	}

	// ── Covenant ──────────────────────────────────────────────────────────

	ratifyCovenant(req: RatifyCovenantRequest): Promise<RatifyCovenantResponse> {
		return this.request("POST", "/covenants", req);
	}

	listCovenants(): Promise<ListCovenantsResponse> {
		return this.request("GET", "/covenants");
	}

	checkPermission(req: CheckPermissionRequest): Promise<CheckPermissionResponse> {
		return this.request("POST", "/covenants/check-permission", req);
	}

	// ── Agents ────────────────────────────────────────────────────────────

	spawnAgent(req: SpawnAgentRequest): Promise<SpawnAgentResponse> {
		return this.request("POST", "/agents", req);
	}

	listAgents(): Promise<ListAgentsResponse> {
		return this.request("GET", "/agents");
	}

	completeAgent(agentId: string, req: CompleteAgentRequest): Promise<void> {
		return this.request("POST", `/agents/${encodeURIComponent(agentId)}`, req);
	}

	// ── Skills ───────────────────────────────────────────────────────────

	registerSkill(req: RegisterSkillRequest): Promise<RegisterSkillResponse> {
		return this.request("POST", "/skills", req);
	}

	listSkills(): Promise<ListSkillsResponse> {
		return this.request("GET", "/skills");
	}

	// ── Plans ────────────────────────────────────────────────────────────

	createPlan(req: CreatePlanRequest): Promise<CreatePlanResponse> {
		return this.request("POST", "/plans", req);
	}

	listPlans(): Promise<ListPlansResponse> {
		return this.request("GET", "/plans");
	}

	// ── Checkpoints ───────────────────────────────────────────────────────

	createCheckpoint(req: CreateCheckpointRequest): Promise<CreateCheckpointResponse> {
		return this.request("POST", "/checkpoints", req);
	}

	listCheckpoints(): Promise<ListCheckpointsResponse> {
		return this.request("GET", "/checkpoints");
	}

	// ── Receipts ──────────────────────────────────────────────────────────

	createReceipt(req: CreateReceiptRequest): Promise<CreateReceiptResponse> {
		return this.request("POST", "/receipts", req);
	}

	listReceipts(): Promise<ListReceiptsResponse> {
		return this.request("GET", "/receipts");
	}

	// ── Handoffs ──────────────────────────────────────────────────────────

	listHandoffs(): Promise<ListHandoffsResponse> {
		return this.request("GET", "/handoffs");
	}

	// ── Relationships ──────────────────────────────────────────────────────

	createRelationship(req: CreateRelationshipRequest): Promise<CreateRelationshipResponse> {
		return this.request("POST", "/relationships", req);
	}

	// ── Hooks ────────────────────────────────────────────────────────────

	recordHookEvent(req: RecordHookEventRequest): Promise<RecordHookEventResponse> {
		return this.request("POST", "/hooks/events", req);
	}

	listHookEvents(): Promise<ListHookEventsResponse> {
		return this.request("GET", "/hooks/events");
	}
}
