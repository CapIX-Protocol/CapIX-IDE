import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendLine, showErrorMessage } = vi.hoisted(() => ({
  appendLine: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine, dispose: vi.fn() })),
    showErrorMessage,
  },
}));

import { logger } from "../src/logger";

describe("production logger", () => {
  beforeEach(() => {
    appendLine.mockClear();
    showErrorMessage.mockClear();
  });

  it("records internal errors without surfacing diagnostic toast spam", () => {
    logger.error("CloudHub.jobs load failed", { error: "HTTP 410" });

    expect(appendLine).toHaveBeenCalledOnce();
    expect(appendLine.mock.calls[0][0]).toContain("CloudHub.jobs load failed");
    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});
