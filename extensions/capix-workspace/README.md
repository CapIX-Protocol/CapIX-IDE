# Capix Workspace

Built-in extension for the standalone CapixIDE. Supplies **remote workspace attach,
port forwarding and private preview UI** (architecture §11.6; target ownership:
`extensions/capix-workspace/`).

## Scope

- **Sessions** tree — workspace sessions owned by the current account/project, with
  live connect state, provider/region and resource kind.
- **Ports & Previews** tree — forwarded workspace ports and their opaque TLS preview
  hostnames under `preview.capix.network`.
- **Attach** — open a workspace session through one outbound mTLS tunnel; resolve
  the `capix-remote+<workspaceId>` authority. No manual token, provider key or
  shell-built SSH command.
- **Reconnect** — resume after sleep/network restart using sequence numbers and a
  cursor; never creates a new billable resource.
- **Forward port / open preview** — proxy a listening workspace port through the
  encrypted tunnel to an opaque TLS preview hostname.

## Trust model

This module is **unprivileged**. It consumes the typed main-process broker over the
`capix:remote:*` and `capix:workspace:*` IPC channels (mirroring the core
`capix-remote` bridge). It never:

- receives the one-use session ticket or the mTLS workload identity,
- constructs a raw SSH command or copies a provider private key,
- issues an authenticated fetch.

Channel handles (`filesystem` / `terminal` / `portForwarder`) are opaque `unknown`
so an untrusted host cannot cast them into a privileged transport.

This is an internal module of one CapixIDE release, not a marketplace extension.
