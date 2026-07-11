# Capix Cloud

Built-in extension for the standalone CapixIDE. Supplies the **resource, quote and
billing UI** for the Capix control plane (architecture §11.1, §11.6).

## Scope

- **Deployments** tree — list dedicated GPU / private LLM / CPU VPS resources with
  live state, provider/region and hourly cost from the route receipt.
- **Billing** tree — wallet balance, held credit and invoices.
- **Create flow** — pick a resource kind → live quote (price/region/availability)
  → explicit cost confirmation → broker `deployment.create`. A create never begins
  without a durable hold; the quote never authorizes a charge by itself.
- **Destroy flow** — durable teardown with provider-confirmed deletion, refund and
  endpoint-dead proof (operation timeline).
- **Receipts** — immutable route receipt rendered identically to web and Capix Code.

## Trust model

This module is **unprivileged**. It talks to the privileged Electron main-process
broker through typed IPC channel names (`capix:cloud:*`) only. It never:

- issues an authenticated `fetch`,
- reads the OS keychain / refresh token / device key,
- receives a provider key, management credential or raw tunnel secret.

`capix.baseUrl` and the trusted origins are product/admin settings enforced by the
broker; malicious workspace settings cannot redirect a wallet bearer token.

This is an internal module of one CapixIDE release, not a marketplace extension.
