#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.VSCODE_DIR || path.join(import.meta.dirname, "..", "vscode"));
const edits = {
  "src/vs/workbench/contrib/void/browser/sidebarActions.ts": [
    ["Void: Open Sidebar", "Capix: Open Chat"],
    ["Void: Add Selection to Chat", "Capix: Add Selection to Chat"],
    ["Void's Settings", "Capix Settings"],
  ],
  "src/vs/workbench/contrib/files/browser/fileActions.contribution.ts": [
    ["&&Open Void Settings", "&&Open Capix Settings"],
  ],
  "src/vs/workbench/contrib/void/common/sendLLMMessageService.ts": [
    ["Please add a provider in Void's Settings.", "Sign in to Capix to use routed inference."],
  ],
  "src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.ts": [
    ["This likely means you specified the wrong endpoint in Void's Settings, or your local model provider like Ollama is powered off.", "The Capix routed inference endpoint is temporarily unavailable."],
  ],
  "src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx/Settings.tsx": [
    ["Void's Settings", "Capix Settings"],
    ["comes packaged with Void", "comes configured with Capix"],
    ["Model not recognized by Void.", "Model not recognized by Capix."],
    ["Void recognizes", "Capix recognizes"],
    ["Void automatically detects locally running models and enables them.", "Capix configures available routed models automatically."],
    ["Void can access any model that you host locally. We automatically detect your local models by default.", "Capix connects to private models provisioned in your account."],
    ["Void can access models from Anthropic, OpenAI, OpenRouter, and more.", "Capix routes inference through the models available to your account."],
    ["visibility of Void suggestions", "visibility of Capix suggestions"],
    ["Transfer your editor settings into Void.", "Transfer your editor settings into CapixIDE."],
    ["Transfer Void's settings and chats in and out of Void.", "Transfer Capix settings and chats."],
    ["helps us keep Void running smoothly", "helps us keep CapixIDE running smoothly"],
    ["Void never sees your code", "Capix never sees your code"],
    ["When disabled, Void will not include", "When disabled, Capix will not include"],
  ],
  "src/vs/workbench/contrib/void/browser/react/src/void-onboarding/VoidOnboarding.tsx": [
    ["Welcome to Void", "Welcome to CapixIDE"],
  ],
};

for (const [relative, replacements] of Object.entries(edits)) {
  const file = path.join(root, relative);
  let text = fs.readFileSync(file, "utf8");
  for (const [from, to] of replacements) text = text.split(from).join(to);
  fs.writeFileSync(file, text);
}
console.log("  done: customer-visible workbench text branded");
