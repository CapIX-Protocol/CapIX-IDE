#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const sourceOnly = process.argv.includes("--source-only");
const target = process.argv.slice(2).find((arg) => arg !== "--source-only");
const root = path.resolve(target || ".");
const forbidden = /\b(opencode|vast|hetzner|void|vscode|visual studio code|vs code|code-oss|cursor|windsurf|remote-ssh)\b/i;
const failures = [];
function scanJson(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  function visit(node, key = "") {
    if (typeof node === "string" && forbidden.test(node)) failures.push(`${file}: ${key}=${node}`);
    else if (Array.isArray(node)) node.forEach((item, i) => visit(item, `${key}[${i}]`));
    else if (node && typeof node === "object") Object.entries(node).forEach(([k, v]) => visit(v, key ? `${key}.${k}` : k));
  }
  visit(value);
}
// Source READMEs are published on the customer-facing repository and can be
// bundled into release extensions. Attribution belongs in NOTICE/licenses,
// never in product documentation.
const sourceRoot = path.resolve(import.meta.dirname, "..");
for (const relative of [
  "README.md",
  "remote/capix-server/README.md",
  "extensions/capix-cloud/README.md",
  "extensions/capix-agent-ui/README.md",
  "extensions/capix-workspace/README.md",
]) {
  const file = path.join(sourceRoot, relative);
  if (!fs.existsSync(file)) { failures.push(`missing customer README ${file}`); continue; }
  if (forbidden.test(fs.readFileSync(file, "utf8"))) failures.push(`${file}: forbidden customer documentation text`);
}

if (!sourceOnly) {
  const appRoot = fs.existsSync(path.join(root, "Contents", "Resources", "app"))
    ? path.join(root, "Contents", "Resources", "app")
    : path.join(root, "resources", "app");
  const product = path.join(appRoot, "product.json");
  if (!fs.existsSync(product)) failures.push(`missing packaged product manifest ${product}`);
  else scanJson(product);
  const extensionsRoot = path.join(appRoot, "extensions");
  for (const name of ["capix-llm", "capix-cloud", "capix-workspace", "capix-agent-ui", "capix-intelligence"]) {
    const ext = path.join(extensionsRoot, name);
    const manifest = path.join(ext, "package.json"); if (!fs.existsSync(manifest)) { failures.push(`missing ${manifest}`); continue; }
    scanJson(manifest);
    for (const entry of fs.readdirSync(ext, { recursive: true })) {
      const relative = String(entry);
      // Skip node_modules dependencies — third-party test files are not customer-facing
      if (relative.includes("node_modules/") || relative.includes("node_modules\\")) continue;
      if (forbidden.test(relative)) failures.push(`${name}: forbidden customer-visible path ${relative}`);
      if (/\.(md|txt)$/i.test(relative)) { const file = path.join(ext, relative); if (fs.statSync(file).isFile() && forbidden.test(fs.readFileSync(file, "utf8"))) failures.push(`${name}: forbidden documentation text in ${relative}`); }
    }
  }
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("Customer-facing branding scan passed.");
