/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-auth — barrel export + IPC registration contract for main↔renderer auth
 *  communication.
 *
 *  The renderer, built-in extension hosts and webviews consume only the typed view-model
 *  surface below. They never receive a refresh token, device key, provider secret or a
 *  generic `authenticatedFetch` (architecture §11.2–11.4, master prompt I2/I3).
 *--------------------------------------------------------------------------------------------*/

export type { AuthState, InitiateLoginResult, CapixAuthService } from "./authService.js";

/**
 * Channel names for the main↔renderer auth bridge. Each operation maps to one typed
 * request/response pair. The broker validates state, audience, project and device on
 * every call; raw `ipcMain.handle("anything", ...)` is prohibited.
 */
export const CapixAuthChannels = {
	/** Renderer → main: open browser PKCE flow. Returns `{ authorizeUrl, state }`. */
	initiateLogin: "capix:auth:initiateLogin",
	/** Renderer → main: complete PKCE from loopback / `capix://` callback. */
	handleCallback: "capix:auth:handleCallback",
	/** Renderer → main: refresh the in-memory access token (rotation/reuse-detected). */
	refresh: "capix:auth:refresh",
	/** Renderer → main: revoke device session and clear local state. */
	logout: "capix:auth:logout",
	/** Renderer → main: observable state for the UI (no secrets). */
	getState: "capix:auth:getState",
	/** Main → renderer: state changed (status/expiry/account/project). */
	onStateChanged: "capix:auth:onStateChanged",
} as const;

export type CapixAuthChannelName =
	| (typeof CapixAuthChannels)[keyof typeof CapixAuthChannels];

/**
 * Typed IPC registration contract. The Electron main process registers exactly these
 * handlers; the renderer registers only `onStateChanged`. There is no generic
 * "call any auth channel" surface, and every response is validated against `AuthState`.
 */
export interface CapixAuthIpcContract {
	[CapixAuthChannels.initiateLogin]: {
		request: void;
		response: import("./authService.js").InitiateLoginResult;
	};
	[CapixAuthChannels.handleCallback]: {
		request: { code: string; state: string };
		response: Awaited<ReturnType<import("./authService.js").CapixAuthService["handleCallback"]>>;
	};
	[CapixAuthChannels.refresh]: {
		request: void;
		response: Awaited<ReturnType<import("./authService.js").CapixAuthService["refresh"]>>;
	};
	[CapixAuthChannels.logout]: {
		request: void;
		response: void;
	};
	[CapixAuthChannels.getState]: {
		request: void;
		response: import("./authService.js").AuthState;
	};
	[CapixAuthChannels.onStateChanged]: {
		request: import("./authService.js").AuthState;
		response: void;
	};
}
