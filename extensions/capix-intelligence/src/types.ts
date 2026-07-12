/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/types - TypeScript interfaces for the Capix Intelligence
 *  API responses. Self-contained (no @capix/contracts dependency) so the
 *  extension compiles standalone inside the VS Code fork.
 *--------------------------------------------------------------------------------------------*/

// ── Memory ────────────────────────────────────────────────────────────────

export type MemoryType =
	| "decision"
	| "pattern"
	| "feedback"
	| "context"
	| "relationship"
	| "anchor";

export interface MemoryNode {
	id: string;
	type: MemoryType;
	content: string;
	source?: string;
	embedding?: number[];
	anchorTx?: string;
	anchorSlot?: number;
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt?: string;
}

export interface WriteMemoryRequest {
	type: MemoryType;
	content: string;
	source?: string;
	metadata?: Record<string, unknown>;
}

export interface WriteMemoryResponse {
	id: string;
	anchorTx?: string;
}

export interface ListMemoryResponse {
	memory: MemoryNode[];
}

export interface RetrieveMemoryRequest {
	query: string;
	topK?: number;
	filterType?: MemoryType;
}

export interface RetrieveMemoryResult {
	node: MemoryNode;
	score: number;
}

export interface RetrieveMemoryResponse {
	results: RetrieveMemoryResult[];
}

export interface AnchorMemoryRequest {
	memoryId: string;
	network?: string;
}

export interface AnchorMemoryResponse {
	txSignature: string;
	slot: number;
}

// ── Graph ────────────────────────────────────────────────────────────────

export interface GraphNode {
	id: string;
	type: string;
	label: string;
	properties?: Record<string, unknown>;
}

export interface GraphEdge {
	source: string;
	target: string;
	type: string;
	properties?: Record<string, unknown>;
}

export interface GraphQueryRequest {
	query?: string;
	nodeTypes?: string[];
	edgeTypes?: string[];
	limit?: number;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

// ── Covenant ──────────────────────────────────────────────────────────────

export type CovenantRuleSeverity = "error" | "warning" | "info";

export interface CovenantRule {
	id: string;
	rule: string;
	severity: CovenantRuleSeverity;
	description?: string;
}

export type CovenantVersionStatus = "draft" | "ratified" | "superseded";

export interface CovenantVersion {
	version: string;
	rules: CovenantRule[];
	createdAt: string;
	status: CovenantVersionStatus;
}

export interface RatifyCovenantRequest {
	rules: CovenantRule[];
	version?: string;
}

export interface RatifyCovenantResponse {
	version: string;
	ratifiedAt: string;
}

export interface ListCovenantsResponse {
	versions: CovenantVersion[];
}

export interface CheckPermissionRequest {
	action: string;
	resource?: string;
	context?: Record<string, unknown>;
}

export interface CheckPermissionResponse {
	allowed: boolean;
	reason?: string;
}

// ── Agents ───────────────────────────────────────────────────────────────

export type AgentStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type TrustLevel = "low" | "medium" | "high" | "autonomous";

export interface AgentRecord {
	id: string;
	name: string;
	role: string;
	status: AgentStatus;
	trustLevel: TrustLevel;
	generation: number;
	parentAgentId?: string;
	projectId?: string;
	createdAt: string;
	completedAt?: string;
	result?: unknown;
}

export interface SpawnAgentRequest {
	name: string;
	role: string;
	task: string;
	trustLevel?: TrustLevel;
	parentAgentId?: string;
	projectId?: string;
	skills?: string[];
}

export interface SpawnAgentResponse {
	id: string;
}

export interface ListAgentsResponse {
	agents: AgentRecord[];
}

export interface CompleteAgentRequest {
	result?: unknown;
	status?: AgentStatus;
}

// ── Skills ──────────────────────────────────────────────────────────────

export interface SkillRecord {
	id: string;
	name: string;
	description: string;
	handler: string;
	version: string;
	registeredAt: string;
}

export interface RegisterSkillRequest {
	name: string;
	description: string;
	handler: string;
	version?: string;
}

export interface RegisterSkillResponse {
	id: string;
}

export interface ListSkillsResponse {
	skills: SkillRecord[];
}

// ── Plans ────────────────────────────────────────────────────────────────

export type PlanStatus =
	| "draft"
	| "approved"
	| "in_progress"
	| "completed"
	| "cancelled";

export type PlanStepStatus =
	| "pending"
	| "in_progress"
	| "done"
	| "skipped";

export interface PlanStep {
	id: string;
	description: string;
	status: PlanStepStatus;
	assigneeAgentId?: string;
	order: number;
}

export interface PlanRecord {
	id: string;
	title: string;
	description: string;
	status: PlanStatus;
	steps: PlanStep[];
	projectId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreatePlanRequest {
	title: string;
	description: string;
	steps?: Array<Pick<PlanStep, "description">>;
	projectId?: string;
}

export interface CreatePlanResponse {
	id: string;
}

export interface ListPlansResponse {
	plans: PlanRecord[];
}

// ── Checkpoints ──────────────────────────────────────────────────────────

export interface CheckpointRecord {
	id: string;
	label: string;
	description?: string;
	projectId?: string;
	agentId?: string;
	state: Record<string, unknown>;
	createdAt: string;
}

export interface CreateCheckpointRequest {
	label: string;
	description?: string;
	agentId?: string;
	state?: Record<string, unknown>;
	projectId?: string;
}

export interface CreateCheckpointResponse {
	id: string;
}

export interface ListCheckpointsResponse {
	checkpoints: CheckpointRecord[];
}

// ── Receipts ─────────────────────────────────────────────────────────────

export type DevReceiptStatus =
	| "pending"
	| "submitted"
	| "confirmed"
	| "distributed";

export interface WorkReceipt {
	id: string;
	agentId: string;
	task: string;
	result?: unknown;
	costMinor?: string;
	currency?: string;
	devTokens?: number;
	status: DevReceiptStatus;
	createdAt: string;
}

export interface CreateReceiptRequest {
	agentId: string;
	task: string;
	result?: unknown;
	costMinor?: string;
	currency?: string;
}

export interface CreateReceiptResponse {
	id: string;
}

export interface ListReceiptsResponse {
	receipts: WorkReceipt[];
}

// ── Handoffs ─────────────────────────────────────────────────────────────

export interface AgentHandoff {
	id: string;
	fromAgentId: string;
	toAgentId: string;
	context: Record<string, unknown>;
	reason: string;
	createdAt: string;
}

export interface ListHandoffsResponse {
	handoffs: AgentHandoff[];
}

// ── Relationships ─────────────────────────────────────────────────────────

export interface CreateRelationshipRequest {
	sourceId: string;
	targetId: string;
	type: string;
	properties?: Record<string, unknown>;
}

export interface CreateRelationshipResponse {
	id: string;
}

// ── Hooks ───────────────────────────────────────────────────────────────

export interface HookEvent {
	id: string;
	event: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface RecordHookEventRequest {
	event: string;
	payload?: Record<string, unknown>;
}

export interface RecordHookEventResponse {
	id: string;
}

export interface ListHookEventsResponse {
	events: HookEvent[];
}

// ── Error (RFC 7807 problem+json) ─────────────────────────────────────────

export interface ProblemDetails {
	type?: string;
	title?: string;
	status?: number;
	detail?: string;
	instance?: string;
	capixCode?: string;
	supportId?: string;
	errors?: Record<string, string[]>;
}

// ── Tree item kind tags ───────────────────────────────────────────────────

export type IntelligenceTreeNodeKind =
	| "plan"
	| "plan-step"
	| "agent"
	| "memory"
	| "memory-group"
	| "covenant-version"
	| "covenant-rule"
	| "decision"
	| "checkpoint"
	| "receipt"
	| "placeholder";
