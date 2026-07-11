# Capix Server

The Capix-owned matching Code-OSS remote server for CapixIDE remote development
(architecture §11.6; target ownership: `remote/capix-server/`).

## Role

`capix-server` is the remote extension host the IDE attaches to through the
`capix-remote+<workspaceId>` authority. It is **not** an assumed Microsoft
Remote-SSH dependency. UI extensions remain local; workspace/language extensions
run in this remote host.

It is installed/updated by the **signed workspace agent** and must match the
desktop compatibility manifest. The agent launches the server by absolute path
(never user `PATH`), with `shell: false` and a scrubbed, allowlisted environment.

## Attach model

- The IDE makes an outbound connection to the Capix tunnel gateway; this server
  also makes an outbound connection. The gateway multiplexes logical streams over
  one mTLS tunnel using sequence numbers and a resumable cursor.
- The server validates the IDE handshake (versions + release manifest + API
  schema), validates the one-use session ticket scope against the control plane,
  then opens only the allowlisted channels (`control | filesystem | file-watch |
  pty | task | logs | port | preview | agent-runtime`).
- Reconnect uses the cursor and never creates a new billable resource.
- The server never holds the customer's refresh token, device key, wallet bearer
  or a provider management credential; those live only in the IDE main-process
  broker and the OS credential store.
- The agent-runtime channel is only opened when the IDE declared
  `allowAgentRuntime`; the bundled Capix Agent Runtime then runs inside the
  workspace isolation boundary.

## Files

- `src/protocol.ts` — handshake and attach protocol types, version compatibility
  check, multiplexed channel framing.
- `src/server.ts` — `CapixRemoteServer` stub matching the IDE release: typed
  `attach` / `resume` / `control` / `frame` / `detach` surface with contract
  enforcement; the transport wiring is injected by the signed workspace agent build.

This server ships as part of one CapixIDE release; its version/digest appears in
the unified release manifest (architecture §17.4).
