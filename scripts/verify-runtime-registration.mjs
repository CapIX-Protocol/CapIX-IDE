#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const vscodeRoot = process.env.VSCODE_DIR || path.join(root, "vscode");
const extensions = ["capix-llm", "capix-cloud", "capix-workspace", "capix-agent-ui", "capix-intelligence"];
const manifests = new Map();

for (const file of ["capix-broker.ts", "capix-ipc-registration.ts", "capix-native-auth.ts", "capix-runtime-bootstrap.ts"]) {
  if (!fs.existsSync(path.join(vscodeRoot, "src", "main", file))) fail(`native runtime module is missing: ${file}`);
}
const mainSource = fs.readFileSync(path.join(vscodeRoot, "src", "main.ts"), "utf8");
if (!mainSource.includes("startCapixNativeRuntime(product)")) fail("native runtime is not invoked by the Electron main-process entrypoint");

function fail(message) {
  console.error(`ERROR: Capix runtime registration verification failed: ${message}`);
  process.exitCode = 1;
}

for (const name of extensions) {
  const extensionRoot = path.join(vscodeRoot, "extensions", name);
  const manifestPath = path.join(extensionRoot, "package.json");
  if (!fs.existsSync(manifestPath)) {
    fail(`${name} is absent from the Code-OSS extensions tree`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifests.set(name, { manifest, extensionRoot });
  if (manifest.publisher !== "capix") fail(`${name} has an unexpected publisher`);
  if (!manifest.activationEvents?.includes("onStartupFinished")) fail(`${name} is not activated by the product`);
  if (manifest.activationEvents?.includes("onUri")) fail(`${name} enables URI credential ingress`);
  if (typeof manifest.main !== "string") {
    fail(`${name} has no desktop extension-host entrypoint`);
  } else if (process.argv.includes("--compiled") && !fs.existsSync(path.resolve(extensionRoot, manifest.main))) {
    fail(`${name} compiled entrypoint is missing: ${manifest.main}`);
  }
}

// A contributed view without a runtime provider makes the workbench surface
// visible but unusable (createTreeView itself throws when the inverse is true).
// Validate the complete built-in set because a provider may live in a sibling
// Capix extension while contributing to the shared Capix activity container.
const registrations = new Map();
for (const [name, { extensionRoot }] of manifests) {
  const sourcePath = path.join(extensionRoot, "src", "extension.ts");
  if (!fs.existsSync(sourcePath)) {
    fail(`${name} runtime source is missing from the packaged extension`);
    continue;
  }
  const source = fs.readFileSync(sourcePath, "utf8");
  const patterns = [
    /createTreeView\(\s*["']([^"']+)["']/g,
    /registerTreeDataProvider\(\s*["']([^"']+)["']/g,
    /registerWebviewViewProvider\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const id = match[1];
      registrations.set(id, [...(registrations.get(id) ?? []), name]);
    }
  }
}

const contributedViews = new Map();
for (const [name, { manifest }] of manifests) {
  for (const views of Object.values(manifest.contributes?.views ?? {})) {
    for (const view of views) {
      if (typeof view?.id !== "string" || !view.id.startsWith("capix.")) continue;
      if (contributedViews.has(view.id)) {
        fail(`view ${view.id} is contributed more than once`);
      }
      contributedViews.set(view.id, name);
    }
  }
}
for (const requiredView of ["capix.agent.sessions"]) {
  if (contributedViews.get(requiredView) !== "capix-agent-ui") {
    fail(`${requiredView} must be packaged as a capix-agent-ui view contribution`);
  }
}
// The canonical chat surface is capix.code.chat in capix-llm; the legacy
// capix.agent.chat view is retired (duplicate panel removed).
if (contributedViews.get("capix.code.chat") !== "capix-llm") {
  fail("capix.code.chat must be packaged as a capix-llm view contribution");
}
if (contributedViews.has("capix.agent.chat")) {
  fail("capix.agent.chat is retired; the canonical chat surface is capix.code.chat");
}
for (const [viewId, contributor] of contributedViews) {
  const providers = registrations.get(viewId) ?? [];
  if (providers.length !== 1) {
    fail(`view ${viewId} from ${contributor} must have exactly one runtime provider; found ${providers.length}`);
  }
}
for (const retiredView of ["capix.cloud.billing", "capix.cloud.deployments"]) {
  if (registrations.has(retiredView)) {
    fail(`${retiredView} is a retired orphan view; use the canonical capix-llm surfaces`);
  }
}

const legacyRoot = path.join(vscodeRoot, "extensions", "capix-llm");
const legacyManifest = JSON.parse(fs.readFileSync(path.join(legacyRoot, "package.json"), "utf8"));
if (legacyManifest.contributes?.configuration?.properties?.["capix.baseUrl"]) fail("capix.baseUrl remains workspace-overridable");

const legacySource = fs.readFileSync(path.join(legacyRoot, "src", "extension.ts"), "utf8");
for (const forbidden of ["registerUriHandler", "Paste your Capix session token", "applySessionToken("]) {
  if (legacySource.includes(forbidden)) fail(`legacy extension contains forbidden credential flow: ${forbidden}`);
}

const apiSource = fs.readFileSync(path.join(legacyRoot, "src", "apiClient.ts"), "utf8");
if (apiSource.includes('getConfiguration("capix").get<string>("baseUrl")')) fail("authenticated API origin is workspace-controlled");

if (!process.exitCode) console.log("Capix runtime registration verification passed.");
