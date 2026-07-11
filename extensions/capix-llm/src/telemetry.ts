import * as vscode from "vscode";
import { logger } from "./logger";

export function initTelemetry(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("capix");
  const enabled = config.get<boolean>("enableCrashReporting", false);
  if (!enabled) return;

  logger.info("Crash reporting enabled (opt-in)");

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason: String(reason) });
  });

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  });
}
