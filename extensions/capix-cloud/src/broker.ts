/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-cloud/broker - typed broker client for the capix-cloud built-in extension.
 *
 *  Wraps `vscode.commands.executeCommand` against the registered Capix bridge
 *  channels. The extension host is unprivileged: every call is a named, audited
 *  broker operation that returns only safe view models. There is intentionally no
 *  generic `authenticatedFetch(url, options)` surface here and no way to construct
 *  one (architecture S11.2-S11.4; non-negotiable invariant: no client selects/calls
 *  a provider or receives provider/shared endpoint credentials).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { CapixCloudChannels } from "./ipc.js";
import type {
	CapixCloudIpcContract,
	DeploymentView,
	QuoteView,
	ResourceKind,
} from "./ipc.js";

type Request<C extends keyof CapixCloudIpcContract> = CapixCloudIpcContract[C]["request"];
type Response<C extends keyof CapixCloudIpcContract> = CapixCloudIpcContract[C]["response"];

/**
 * A typed Capix error surfaced to the UI. The broker maps provider/network errors
 * to typed 401/402/403/409/429/provider codes plus a support id; this is never a raw
 * fetch rejection (architecture S11.4).
 */
export class CapixCloudError extends Error {
	constructor(
		public readonly capixCode: string,
		message: string,
		public readonly supportId?: string,
	) {
		super(message);
		this.name = "CapixCloudError";
	}
}

/** Not authenticated: prompt the user through the capix-auth broker flow. */
export class CapixCloudAuthError extends CapixCloudError {
	constructor(supportId?: string) {
		super("401", "Not signed in to Capix.", supportId);
		this.name = "CapixCloudAuthError";
	}
}

/**
 * Customer-facing create-confirmation text. Provider names are internal
 * routing detail and must never appear in customer-facing output — only the
 * resource kind, region and exact cost are shown.
 */
export function deploymentCreateConfirmMessage(
	quote: Pick<QuoteView, "resourceKind" | "region" | "costMinorPerHour" | "currency">,
	formatMinor: (minor: string, currency: string) => string,
): string {
	const perHour = formatMinor(quote.costMinorPerHour, quote.currency);
	return `Capix: create ${quote.resourceKind} in ${quote.region} at ${perHour}/hr?`;
}

export class CapixCloudBroker {
	/** Invoke one typed broker operation through the IDE IPC bridge. */
	async call<C extends keyof CapixCloudIpcContract>(
		channel: C,
		request: Request<C>,
	): Promise<Response<C>> {
		try {
			return (await vscode.commands.executeCommand(
				channel as string,
				request,
			)) as Response<C>;
		} catch (err) {
			throw this.mapError(err);
		}
	}

	/** List deployments with resumable cursor pagination. */
	listDeployments(cursor?: string): Promise<{
		deployments: DeploymentView[];
		nextCursor?: string;
	}> {
		return this.call(CapixCloudChannels.listDeployments, { cursor });
	}

	getDeployment(id: string): Promise<DeploymentView> {
		return this.call(CapixCloudChannels.getDeployment, { id });
	}

	/** Fetch a live quote. A create never begins without an accepted quote + hold. */
	createQuote(params: {
		resourceKind: ResourceKind;
		provider?: string;
		region?: string;
		modelId?: string;
	}): Promise<QuoteView> {
		return this.call(CapixCloudChannels.createQuote, params);
	}

	/**
	 * quote -> human cost confirmation -> create. The human-confirmed cost is passed
	 * back to the broker so a tampered quote id/cost mismatch fails server-side.
	 */
	async quoteAndCreate(params: {
		resourceKind: ResourceKind;
		name: string;
		provider?: string;
		region?: string;
		modelId?: string;
	}): Promise<{ deploymentId: string; operationId: string }> {
		const quote = await this.createQuote(params);
		const confirmed = await this.confirmCost(quote);
		if (!confirmed) {
			throw new CapixCloudError("aborted", "Create cancelled by user.");
		}
		return this.call(CapixCloudChannels.createDeployment, {
			quoteId: quote.id,
			name: params.name,
			costMinorPerHour: quote.costMinorPerHour,
		});
	}

	deleteDeployment(id: string): Promise<{ operationId: string }> {
		return this.call(CapixCloudChannels.deleteDeployment, { id });
	}

	subscribeOperation(
		id: string,
		cursor?: string,
	): Promise<CapixCloudIpcContract[typeof CapixCloudChannels.subscribeOperation]["response"]> {
		return this.call(CapixCloudChannels.subscribeOperation, { id, cursor });
	}

	cancelOperation(id: string): Promise<void> {
		return this.call(CapixCloudChannels.cancelOperation, { id });
	}

	getBalance(): Promise<CapixCloudIpcContract[typeof CapixCloudChannels.getBalance]["response"]> {
		return this.call(CapixCloudChannels.getBalance, undefined as never);
	}

	listInvoices(): Promise<{
		invoices: CapixCloudIpcContract[typeof CapixCloudChannels.listInvoices]["response"]["invoices"];
	}> {
		return this.call(CapixCloudChannels.listInvoices, undefined as never);
	}

	getReceipt(id: string): Promise<CapixCloudIpcContract[typeof CapixCloudChannels.getReceipt]["response"]> {
		return this.call(CapixCloudChannels.getReceipt, { id });
	}

	// --- helpers -------------------------------------------------------------

	/** Show exact cost/route before a billable create; the quote never authorizes a charge. */
	private async confirmCost(quote: QuoteView): Promise<boolean> {
		const eta = quote.estimatedReadySec
			? `~${Math.ceil(quote.estimatedReadySec / 60)} min to ready`
			: "readiness TBD";
		const choice = await vscode.window.showWarningMessage(
			deploymentCreateConfirmMessage(quote, (minor, ccy) => this.formatMinor(minor, ccy)),
			{ modal: true, detail: `${eta}. This starts a durable hold and billable resource.` },
			"Create",
			"Cancel",
		);
		return choice === "Create";
	}

	private formatMinor(minor: string, currency: string): string {
		const n = Number(minor);
		if (!Number.isFinite(n)) return `${minor} ${currency}`;
		return `${(n / 100).toFixed(2)} ${currency}`;
	}

	private mapError(err: unknown): Error {
		if (err instanceof CapixCloudError) return err;
		const e = err as { code?: string; capixCode?: string; message?: string; supportId?: string };
		const code = e?.capixCode ?? e?.code ?? "unknown";
		const message = e?.message ?? "Capix broker operation failed.";
		const mapped = new CapixCloudError(String(code), message, e?.supportId);
		if (code === "401") return new CapixCloudAuthError(e?.supportId);
		return mapped;
	}
}
