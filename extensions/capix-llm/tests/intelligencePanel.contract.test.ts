import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn() },
  window: { showErrorMessage: vi.fn() },
}));

import { intelligenceList } from "../src/intelligencePanel";
import { truncate } from "../src/intelligencePanelAssets";

describe("Intelligence canonical list contracts", () => {
  it("renders malformed or partial text fields without crashing the panel", () => {
    expect(truncate(undefined, 20)).toBe("");
    expect(truncate(null, 20)).toBe("");
    expect(truncate(1234, 20)).toBe("1234");
  });

  it("reads the canonical paginated data array", () => {
    const items = [{ id: "mem_1" }];
    expect(intelligenceList({ data: items }, "memory")).toEqual(items);
  });

  it("keeps compatibility with a legacy named list", () => {
    const items = [{ id: "cov_1" }];
    expect(intelligenceList({ versions: items }, "versions")).toEqual(items);
  });

  it("prefers canonical data and fails closed to an empty array", () => {
    expect(
      intelligenceList(
        { data: [{ id: "canonical" }], agents: [{ id: "legacy" }] },
        "agents",
      ),
    ).toEqual([{ id: "canonical" }]);
    expect(intelligenceList(undefined, "skills")).toEqual([]);
    expect(intelligenceList({ data: undefined }, "receipts")).toEqual([]);
  });
});
