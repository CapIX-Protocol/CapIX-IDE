/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-broker/security-config — product/admin-controlled security constants
 *  for the Electron main process (architecture §11.2, §11.6, §11.7).
 *
 *  These values are PRODUCT defaults set by Capix and the customer administrator.
 *  They are NOT overridable from workspace settings: a malicious
 *  `.vscode/settings.json` cannot relax context isolation, add a trusted origin,
 *  disable IPC validation, allow agent shell execution, or lower the update
 *  signature requirement. Workspace-controlled settings are layered only on top
 *  of (and never in place of) these constants.
 *--------------------------------------------------------------------------------------------*/

export const SECURITY_CONFIG = {
	// Renderer
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,

	// Webviews
	webviewCsp: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
	webviewStrictOrigin: true,

	// IPC
	ipcValidateOrigin: true,
	ipcValidateSchema: true,

	// Navigation
	blockExternalNavigation: true,
	blockNewWindow: true,

	// Protocol handler
	capixProtocolScheme: "capix",
	capixProtocolAllowedPaths: ["/auth/callback", "/open"],

	// Trusted origins (product/admin-controlled, NOT workspace-controlled)
	trustedOrigins: [
		"vscode-file://vscode-app",
		"https://www.capix.network",
		"https://api.capix.network",
		"http://localhost:3000", // dev only
	],

	// Agent runtime
	agentLaunchByAbsolutePath: true,
	agentScrubEnvironment: true,
	agentNoShell: true,

	// Update
	updateRequiresSignature: true,
	updateRequiresCompatibility: true,

	// Workspace trust
	workspaceTrustRequired: true,
	workspaceTrustBeforeTasks: true,
	workspaceTrustBeforePlugins: true,
	workspaceTrustBeforeNetwork: true,
} as const;

export type SecurityConfig = typeof SECURITY_CONFIG;
