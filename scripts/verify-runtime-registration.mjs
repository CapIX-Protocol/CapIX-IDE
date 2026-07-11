#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const vscodeRoot = process.env.VSCODE_DIR || path.join(root, "vscode");
const extensions = ["capix-llm", "capix-cloud", "capix-workspace", "capix-agent-ui"];

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
  if (manifest.publisher !== "capix") fail(`${name} has an unexpected publisher`);
  if (!manifest.activationEvents?.includes("onStartupFinished")) fail(`${name} is not activated by the product`);
  if (manifest.activationEvents?.includes("onUri")) fail(`${name} enables URI credential ingress`);
  if (typeof manifest.main !== "string") {
    fail(`${name} has no desktop extension-host entrypoint`);
  } else if (process.argv.includes("--compiled") && !fs.existsSync(path.resolve(extensionRoot, manifest.main))) {
    fail(`${name} compiled entrypoint is missing: ${manifest.main}`);
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
