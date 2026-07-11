import * as vscode from "vscode";

let channel: vscode.OutputChannel | null = null;

function getChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("CapixIDE");
  return channel;
}

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const entry = data
    ? `[${ts}] [${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`
    : `[${ts}] [${level.toUpperCase()}] ${message}`;
  getChannel().appendLine(entry);
  if (level === "error") console.error(entry);
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => {
    log("error", msg, data);
    vscode.window.showErrorMessage(`CapixIDE: ${msg}`);
  },
};
