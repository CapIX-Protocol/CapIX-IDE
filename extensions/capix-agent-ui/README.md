# Capix Agent

Built-in extension for the standalone CapixIDE. Supplies **agent sessions, the chat
view and tool approval** for the bundled Capix Agent Runtime (architecture §11.5;
target ownership: `extensions/capix-agent-ui/`).

## Scope

- **Sessions** tree — resumable agent/chat sessions with model id and accumulated
  usage cost from the route receipt.
- **Chat** view — streamed content/tool-call deltas, route receipt, usage/cost,
  cancel; mirrors the server-side `capix.route` / `capix.usage` / `capix.final`
  stream extensions so placement, privacy, usage and final cost render identically
  in web, IDE and Capix Code.
- **Start / resume session** — start bound to a stable model id (or `auto`/owned
  private resource id + saved policy id) and a project.
- **Tool approval** — every deferred tool call shows the exact executable/args/
  cwd/env-delta/network/timeout/side-effect (and billable cost when relevant)
  before human confirmation; approve/deny is separate from the prompt.

## Trust model

This module is the graphical client of the bundled Capix Agent Runtime and is
**unprivileged**. It consumes the typed main-process broker over the `capix:chat:*`
and `capix:agent:*` IPC channels (mirroring the core `capix-ai` bridge). It never:

- issues a raw model HTTP call or receives the hosted vLLM key,
- bypasses the broker route/usage attribution,
- enforces tool policy in a prompt (the broker enforces it; approval prompts are
  not a sandbox).

Disconnect fails pending permissions closed: any in-flight approval prompt that
did not complete is treated as denied.

This is an internal module of one CapixIDE release, not a marketplace extension.
