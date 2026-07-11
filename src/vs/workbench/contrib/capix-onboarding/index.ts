/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-onboarding — barrel export + IPC registration contract for main↔renderer
 *  onboarding communication.
 *
 *  The renderer drives first-run through typed IPC only and never handles PKCE
 *  verifier/nonce/device keys or any credential directly; those live in the
 *  `capix-auth` broker (architecture §11.3; master prompt I1/I3).
 *--------------------------------------------------------------------------------------------*/

export type { OnboardingState } from "./firstRun.js";
export { CapixOnboardingService } from "./firstRun.js";

/**
 * Channel names for the main↔renderer onboarding bridge.
 */
export const CapixOnboardingChannels = {
	/** Renderer → main: begin first-run detection / step advance. */
	startFirstRun: "capix:onboarding:startFirstRun",
	/** Renderer → main: open system browser PKCE auth. */
	startAuth: "capix:onboarding:startAuth",
	/** Renderer → main: complete PKCE from loopback / `capix://` callback. */
	completeAuth: "capix:onboarding:completeAuth",
	/** Renderer → main: select or create the active project. */
	selectProject: "capix:onboarding:selectProject",
	/** Renderer → main: mark onboarding complete. */
	complete: "capix:onboarding:complete",
	/** Main → renderer: onboarding step/state changed. */
	onStateChanged: "capix:onboarding:onStateChanged",
} as const;

export type CapixOnboardingChannelName =
	| (typeof CapixOnboardingChannels)[keyof typeof CapixOnboardingChannels];

/**
 * Typed IPC registration contract. `startAuth` returns only the browser URL;
 * `completeAuth` carries `code`/`state` and never a session/access/refresh token.
 */
export interface CapixOnboardingIpcContract {
	[CapixOnboardingChannels.startFirstRun]: {
		request: void;
		response: import("./firstRun.js").OnboardingState;
	};
	[CapixOnboardingChannels.startAuth]: {
		request: void;
		response: { browserUrl: string };
	};
	[CapixOnboardingChannels.completeAuth]: {
		request: { code: string; state: string };
		response: import("./firstRun.js").OnboardingState;
	};
	[CapixOnboardingChannels.selectProject]: {
		request: { projectId: string };
		response: import("./firstRun.js").OnboardingState;
	};
	[CapixOnboardingChannels.complete]: {
		request: void;
		response: void;
	};
	[CapixOnboardingChannels.onStateChanged]: {
		request: import("./firstRun.js").OnboardingState;
		response: void;
	};
}
