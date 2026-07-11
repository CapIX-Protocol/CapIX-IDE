/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-cloud/ipc - typed IPC contract between the capix-cloud built-in extension
 *  and the privileged main-process broker (architecture S11.2, S11.4, S11.6).
 *
 *  capix-cloud is the resource, quote and billing surface of the standalone IDE. It
 *  is an internal module: it never issues an authenticated fetch, never reads the OS
 *  keychain and never holds a refresh/device token. It requests the named, audited
 *  broker operations through the channels below and renders only safe view models
 *  (deployments, operations, balance, invoices, receipts). A malicious
 *  `.vscode/settings.json` cannot redirect a wallet bearer token: `capix.baseUrl` is
 *  a product/admin setting enforced by the broker.
 *--------------------------------------------------------------------------------------------*/

/** Lifecycle phase of a Capix deployment (architecture S11.6 Progress/Operate). */
export type DeploymentState =
	| "PENDING"
	| "HOLD"
	| "PROVISIONING"
	| "BOOTSTRAPPING"
	| "VERIFYING"
	| "READY"
	| "STOPPED"
	| "STOPPING"
	| "DELETING"
	| "TERMINATED"
	| "FAILED";

export type ResourceKind = "dedicated-gpu" | "private-llm" | "cpu-vps";

/**
 * Safe deployment view model for the tree. The provider IP/credential and the raw
 * management key are deliberately absent; managed attach goes through the
 * capix-workspace remote authority, not a copied SSH command.
 */
export interface DeploymentView {
	id: string;
	name: string;
	resourceKind: ResourceKind;
	provider?: string;
	region?: string;
	state: DeploymentState;
	/** Hourly cost in native minor units once READY (from the route receipt). */
	costMinorPerHour?: string;
	currency?: string;
	/** Operation id of the latest lifecycle op (subscribe/cancel surface). */
	lastOperationId?: string;
	/** Epoch ms the deployment entered its current state. */
	stateChangedAt?: number;
}

/**
 * Quote returned BEFORE a billable create. Per the non-negotiable invariant, no
 * create begins without a durable hold and no paid mutation is authorized by the
 * quote alone: the IDE shows exact cost and the human confirms a separate
 * short-lived commit token.
 */
export interface QuoteView {
	id: string;
	resourceKind: ResourceKind;
	provider: string;
	region: string;
	/** Quoted hourly cost in native minor units; fixed at quote/hold time. */
	costMinorPerHour: string;
	currency: string;
	/** Quote expiry (epoch ms). A stale quote is an explicit blocked outcome. */
	expiresAt: number;
	/** Estimated time-to-ready (seconds) when capacity is fixed-compatible. */
	estimatedReadySec?: number;
}

/** Operation timeline entry (hold -> provider -> bootstrap -> verify -> ready/delete). */
export interface OperationEventView {
	id: string;
	phase:
		| "hold"
		| "provider"
		| "bootstrap"
		| "verify"
		| "ready"
		| "delete"
		| "reconcile"
		| "failed";
	message: string;
	occurredAt: number;
}

export interface BalanceView {
	availableMinor: string;
	/** Held credit in native minor units (open holds/captures). */
	heldMinor: string;
	currency: string;
}

export interface InvoiceView {
	id: string;
	number: string;
	periodStart: number;
	periodEnd: number;
	totalMinor: string;
	currency: string;
	status: "draft" | "open" | "paid" | "void" | "uncollectible";
	url?: string;
}

/** Immutable route receipt. Rendered identically in web, IDE and Capix Code. */
export interface ReceiptView {
	id: string;
	operationId: string;
	/** Final cost in native minor units; equals the ledger posting. */
	costMinor: string;
	currency: string;
	model?: string;
	region?: string;
	privacy?: string;
	provider?: string;
	createdAt: number;
}

/**
 * Channel names for the main <-> cloud-extension bridge. Each maps to exactly one
 * audited broker operation that performs status/runtime validation, timeout/cancel,
 * safe retry, mandatory idempotency, correlation/release IDs, version negotiation,
 * trusted-host TLS, operation-cursor resume and typed 401/402/403/409/429/provider
 * error mapping. The extension never sees the underlying HTTP (architecture S11.4).
 */
export const CapixCloudChannels = {
	/** deployment.list over the broker. */
	listDeployments: "capix:cloud:listDeployments",
	/** deployment.get over the broker. */
	getDeployment: "capix:cloud:getDeployment",
	/** quote.create: live price/region/availability, never a charge. */
	createQuote: "capix:cloud:createQuote",
	/** deployment.create: requires an accepted quote and human-confirmed cost. */
	createDeployment: "capix:cloud:createDeployment",
	/** deployment.delete (setDesired=terminated): durable teardown + provider-confirmed deletion. */
	deleteDeployment: "capix:cloud:deleteDeployment",
	/** operation.subscribe: resumable event cursor for the operation timeline. */
	subscribeOperation: "capix:cloud:subscribeOperation",
	/** operation.cancel: idempotent cancel of an in-flight lifecycle op. */
	cancelOperation: "capix:cloud:cancelOperation",
	/** billing.getBalance. */
	getBalance: "capix:cloud:getBalance",
	/** billing.listInvoices. */
	listInvoices: "capix:cloud:listInvoices",
	/** receipt.get. */
	getReceipt: "capix:cloud:getReceipt",
} as const;

export type CapixCloudChannelName =
	| (typeof CapixCloudChannels)[keyof typeof CapixCloudChannels];

/** Typed request/response pairs for every cloud bridge operation. */
export interface CapixCloudIpcContract {
	[CapixCloudChannels.listDeployments]: {
		request: { cursor?: string };
		response: { deployments: DeploymentView[]; nextCursor?: string };
	};
	[CapixCloudChannels.getDeployment]: {
		request: { id: string };
		response: DeploymentView;
	};
	[CapixCloudChannels.createQuote]: {
		request: {
			resourceKind: ResourceKind;
			provider?: string;
			region?: string;
			modelId?: string;
		};
		response: QuoteView;
	};
	[CapixCloudChannels.createDeployment]: {
		request: { quoteId: string; name: string; costMinorPerHour: string };
		response: { deploymentId: string; operationId: string };
	};
	[CapixCloudChannels.deleteDeployment]: {
		request: { id: string };
		response: { operationId: string };
	};
	[CapixCloudChannels.subscribeOperation]: {
		request: { id: string; cursor?: string };
		response: { events: OperationEventView[]; done: boolean; nextCursor?: string };
	};
	[CapixCloudChannels.cancelOperation]: {
		request: { id: string };
		response: void;
	};
	[CapixCloudChannels.getBalance]: {
		request: void;
		response: BalanceView;
	};
	[CapixCloudChannels.listInvoices]: {
		request: void;
		response: { invoices: InvoiceView[] };
	};
	[CapixCloudChannels.getReceipt]: {
		request: { id: string };
		response: ReceiptView;
	};
}
