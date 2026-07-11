#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const forbidden = /\b(opencode|vast|hetzner|void|vscode)\b/i;
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
for (const file of [path.join(root, "Contents", "Resources", "app", "product.json")]) if (fs.existsSync(file)) scanJson(file);
const extensionsRoot = path.join(root, "Contents", "Resources", "app", "extensions");
for (const name of ["capix-llm", "capix-cloud", "capix-workspace", "capix-agent-ui"]) {
  const ext = path.join(extensionsRoot, name);
  const manifest = path.join(ext, "package.json"); if (!fs.existsSync(manifest)) { failures.push(`missing ${manifest}`); continue; }
  scanJson(manifest);
  for (const entry of fs.readdirSync(ext, { recursive: true })) {
    const relative = String(entry); if (forbidden.test(relative)) failures.push(`${name}: forbidden customer-visible path ${relative}`);
    if (/\.(md|txt)$/i.test(relative)) { const file = path.join(ext, relative); if (fs.statSync(file).isFile() && forbidden.test(fs.readFileSync(file, "utf8"))) failures.push(`${name}: forbidden documentation text in ${relative}`); }
  }
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("Customer-facing branding scan passed.");
