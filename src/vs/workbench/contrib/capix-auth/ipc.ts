/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-auth/ipc — the typed IPC contract between the Electron main process and the
 *  workbench renderer (architecture §11.2, §11.4).
 *
 *  Trust model:
 *    - The renderer is unprivileged. It may only emit one of the type-tagged
 *      `RendererToMainMessage` operations below and may only receive one of the
 *      `MainToRendererMessage` view models.
 *    - There is deliberately NO generic "fetch" / "authenticatedRequest" /
 *      "httpCall" message type. The renderer can never ask the broker to perform an
 *      arbitrary authenticated HTTP request; it can only request a named, audited
 *      SDK operation. The main process validates the origin and schema of every
 *      message before dispatching through the generated Capix SDK.
 *    - Access/refresh tokens, device keys, provider keys and tunnel master tickets
 *      never appear in either direction. Only safe view models cross the boundary.
 *
 *  This contract is the lower-level message envelope. The channel-keyed
 *  `CapixAuthIpcContract` in `./index.ts` maps each operation to a registered IPC
 *  channel; both layers must stay in sync.
 *--------------------------------------------------------------------------------------------*/

import type { AuthState } from "./authService.js";

/**
 * Main → Renderer messages. These carry ONLY safe, non-secret view models: auth
 * state, the authorize URL to open in the system browser, and human-readable
 * errors. No access token, refresh token, device key or provider secret is ever
 * sent to the renderer.
 */
export type MainToRendererMessage =
	| { type: "auth:state"; state: AuthState }
	| { type: "auth:login:url"; url: string }
	| { type: "auth:error"; error: string };

/**
 * Renderer → Main messages. This is the exhaustive set of operations the
 * renderer is permitted to request. Each maps to one privileged broker operation
 * that performs status/runtime validation, timeout/cancel, safe retry, mandatory
 * idempotency, correlation IDs and typed error mapping before touching the
 * control plane (architecture §11.4).
 *
 * CRITICAL: No "fetch" or generic authenticated request message type exists in
 * this union. The renderer can ONLY call these typed operations. The main
 * process validates every message's origin and schema against this union before
 * dispatch, and rejects anything that does not match exactly.
 */
export type RendererToMainMessage =
	| { type: "auth:login:start" }
	| { type: "auth:login:callback"; code: string; state: string }
	| { type: "auth:logout" }
	| { type: "auth:getToken" }
	| { type: "account:get" }
	| { type: "catalog:models" }
	| { type: "quote:create"; input: unknown }
	| { type: "deployment:create"; input: unknown }
	| { type: "deployment:get"; id: string }
	| { type: "deployment:list"; cursor?: string }
	| { type: "operation:subscribe"; id: string }
	| { type: "operation:cancel"; id: string }
	| { type: "inference:stream"; input: unknown }
	| { type: "inference:cancel"; sessionId: string }
	| { type: "billing:balance" }
	| { type: "billing:invoices" }
	| { type: "receipt:get"; id: string }
	| { type: "workspace:connect"; workspaceId: string }
	| { type: "workspace:disconnect" };
