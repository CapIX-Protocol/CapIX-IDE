import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { deploymentCreateConfirmMessage } from "../../capix-cloud/src/broker";

describe("capix-cloud customer-facing branding", () => {
  it("create confirmation shows kind, region and exact cost — never a provider name", () => {
    const message = deploymentCreateConfirmMessage(
      { resourceKind: "dedicated-gpu", region: "us-east", costMinorPerHour: "45000", currency: "USD" },
      (minor, ccy) => `${(Number(minor) / 100).toFixed(2)} ${ccy}`,
    );

    expect(message).toContain("dedicated-gpu");
    expect(message).toContain("us-east");
    expect(message).toContain("450.00 USD/hr");
    // Provider names are internal routing detail and must never reach customers.
    expect(message).not.toMatch(/provider/i);
    expect(message).not.toMatch(/\b(vast|hetzner|lambda|runpod)\b/i);
  });
});
