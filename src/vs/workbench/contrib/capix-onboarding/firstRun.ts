/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-onboarding — first-run experience for the signed standalone product.
 *
 *  Clean install never displays Void, asks for Void providers, or carries Void
 *  identity/telemetry/update boundaries (architecture §11.1, §11.3; master prompt I1/I3).
 *  Authentication uses the native-app authorization-code + PKCE pattern with the system
 *  browser (RFC 8252).
 *--------------------------------------------------------------------------------------------*/

import type { Memento, SecretStorage } from "vscode";
import type { AuthState, CapixAuthService } from "../capix-auth/authService.js";

/**
 * Observable onboarding state. Safe to render; contains no secret. The steps are linear:
 * welcome → auth → project → ready. A returning user skips directly to `ready`.
 */
export interface OnboardingState {
	step: "welcome" | "auth" | "project" | "ready";
	isFirstRun: boolean;
	authComplete: boolean;
	projectSelected: boolean;
	/** Human-readable error for the current step (e.g. a failed PKCE exchange). Cleared on success. */
	error?: string;
}

/** Persisted onboarding state keys. Non-secret values live in globalState; the auth snapshot lives in secrets. */
const COMPLETE_KEY = "capix.onboarding.complete";
const STEP_KEY = "capix.onboarding.step";
const PROJECT_KEY = "capix.onboarding.projectId";
const AUTH_SECRET_KEY = "capix.onboarding.auth";

/**
 * The first-run onboarding service. Implemented in the Electron main process; the
 * renderer consumes typed view-models only. It delegates the actual PKCE exchange to the
 * `capix-auth` broker — it never handles refresh tokens, device keys or provider
 * credentials itself.
 */
export class CapixOnboardingService {
	/**
	 * @param authService The privileged Capix auth broker that owns PKCE verifier/nonce/device key.
	 * @param globalState VS Code memento for non-secret onboarding data (step, project, completion flag).
	 * @param secrets VS Code secret storage for auth-related data (authenticated account snapshot).
	 */
	constructor(
		private readonly authService: CapixAuthService,
		private readonly globalState: Memento,
		private readonly secrets: SecretStorage,
	) {}

	/**
	 * Called on first launch. Determines whether this is a first run and advances to the
	 * appropriate step. Never shows Void identity, providers or settings.
	 */
	async startFirstRun(): Promise<OnboardingState> {
		if (this.globalState.get<boolean>(COMPLETE_KEY, false)) {
			return this.view("ready");
		}

		const persistedStep = this.globalState.get<OnboardingState["step"] | undefined>(STEP_KEY);
		if (persistedStep === "auth" || persistedStep === "project") {
			return this.view(persistedStep);
		}

		return this.view("welcome");
	}

	/**
	 * Open the system browser for PKCE auth. Returns only the browser URL; the verifier,
	 * nonce and device key stay in the auth broker. The desktop loopback listener (or
	 * signed `capix://auth/callback`) is armed before the browser opens.
	 */
	async startAuth(): Promise<{ browserUrl: string }> {
		await this.globalState.update(STEP_KEY, "auth");

		const result = await this.authService.initiateLogin();

		return { browserUrl: result.authorizeUrl };
	}

	/**
	 * Complete auth from the loopback / `capix://` callback. Validates state and device,
	 * exchanges the code over TLS via the auth broker, and advances onboarding to the
	 * project step. `code`/`state` never carry a session/access/refresh token.
	 */
	async completeAuth(code: string, state: string): Promise<OnboardingState> {
		let auth: AuthState;
		try {
			auth = await this.authService.handleCallback(code, state);
		} catch (err) {
			await this.globalState.update(STEP_KEY, "auth");
			return this.view("auth", this.errorMessage(err));
		}

		if (auth.status !== "authenticated") {
			await this.globalState.update(STEP_KEY, "auth");
			return this.view("auth", `Authentication failed (${auth.status}).`);
		}

		await this.secrets.store(AUTH_SECRET_KEY, JSON.stringify(auth));
		await this.globalState.update(STEP_KEY, "project");

		return this.view("project");
	}

	/**
	 * Select or create the active project. Sets the project/audience scope for subsequent
	 * privileged calls (catalog, quote, deployment, inference, tunnel).
	 */
	async selectProject(projectId: string): Promise<OnboardingState> {
		if (!projectId) {
			return this.view("project", "No project selected.");
		}

		await this.globalState.update(PROJECT_KEY, projectId);
		await this.globalState.update(STEP_KEY, "ready");

		return this.view("ready");
	}

	/** Mark onboarding complete and persist the first-run flag. */
	async complete(): Promise<void> {
		await this.globalState.update(STEP_KEY, "ready");
		await this.globalState.update(COMPLETE_KEY, true);
	}

	/** Build the observable state for a step, deriving flags and resolving `isFirstRun` from the completion flag. */
	private view(step: OnboardingState["step"], error?: string): OnboardingState {
		const complete = this.globalState.get<boolean>(COMPLETE_KEY, false);

		return {
			step,
			isFirstRun: !complete,
			authComplete: step === "project" || step === "ready",
			projectSelected: step === "ready",
			error,
		};
	}

	/** Normalize an unknown caught value into a human-readable message. */
	private errorMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}
}
