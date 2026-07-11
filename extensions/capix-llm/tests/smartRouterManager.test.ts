import { describe, it, expect, beforeEach, vi } from "vitest";

const mockShowInfoMsg = vi.fn();
const mockShowErrorMsg = vi.fn();
const mockShowWarnMsg = vi.fn();
const mockShowQuickPick = vi.fn();
const mockWithProgress = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: mockShowInfoMsg,
    showErrorMessage: mockShowErrorMsg,
    showWarningMessage: mockShowWarnMsg,
    showQuickPick: mockShowQuickPick,
    withProgress: mockWithProgress,
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn().mockResolvedValue(undefined),
    })),
  },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 1 },
}));

const mockExistsSync = vi.fn(() => false);
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/user"),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
  dirname: vi.fn((p: string) => p.split("/").slice(0, -1).join("/")),
}));

import { SmartRouterManager } from "../src/smartRouterManager";

interface MockClient {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  getBaseUrl: ReturnType<typeof vi.fn>;
  storeSecret: ReturnType<typeof vi.fn>;
}

function createMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    get: vi.fn().mockResolvedValue({ ok: false }),
    post: vi.fn().mockResolvedValue({ ok: false }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    getBaseUrl: vi.fn().mockReturnValue("https://capix.network"),
    storeSecret: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createTestRouter(clientOverrides: Partial<MockClient> = {}): SmartRouterManager {
  const client = createMockClient(clientOverrides);
  return new SmartRouterManager(client);
}

describe("SmartRouterManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
    mockWriteFileSync.mockReturnValue(undefined);
    mockMkdirSync.mockReturnValue(undefined);
    mockShowInfoMsg.mockResolvedValue(undefined);
    mockShowErrorMsg.mockResolvedValue(undefined);
    mockShowWarnMsg.mockResolvedValue(undefined);
    mockShowQuickPick.mockResolvedValue(undefined);
    mockWithProgress.mockImplementation((_opts, fn) => fn({ report: vi.fn() }));
  });

  describe("initialization and memory loading", () => {
    it("should initialize with blank memory when no memory file exists", () => {
      mockExistsSync.mockReturnValue(false);
      const router = createTestRouter();

      expect(router.getMode()).toBe("auto");
      expect(router.hasPrivateEndpoint()).toBe(false);
      expect(router.getMemorySummary()).toContain("Routing mode: AUTO");
    });

    it("should load memory from file when it exists", () => {
      mockExistsSync.mockReturnValue(true);
      const savedMemory = {
        ratings: {
          "model-a": {
            reasoning: { score: 10, selections: 5, overrides: 1 },
            coding: { score: 8, selections: 3, overrides: 0 },
          },
        },
        blockedModels: ["bad-model"],
        favoredModels: ["good-model"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(savedMemory));

      const router = createTestRouter();
      const summary = router.getMemorySummary();

      expect(summary).toContain("Blocked: bad-model");
      expect(summary).toContain("Favored: good-model");
      expect(summary).toContain("model-a");
    });

    it("should fall back to blank memory on parse error", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not valid json {{{");

      const router = createTestRouter();
      const summary = router.getMemorySummary();

      expect(summary).toContain("Blocked: none");
      expect(summary).toContain("Favored: none");
    });
  });

  describe("mode selection", () => {
    it("should return auto mode by default", () => {
      delete process.env.CAPIX_ROUTE_MODE;
      const router = createTestRouter();
      expect(router.getMode()).toBe("auto");
    });

    it("should return private mode when env is set", () => {
      process.env.CAPIX_ROUTE_MODE = "private";
      const router = createTestRouter();
      expect(router.getMode()).toBe("private");
      delete process.env.CAPIX_ROUTE_MODE;
    });

    it("should return loop mode when env is set", () => {
      process.env.CAPIX_ROUTE_MODE = "loop";
      const router = createTestRouter();
      expect(router.getMode()).toBe("loop");
      delete process.env.CAPIX_ROUTE_MODE;
    });
  });

  describe("private endpoint lifecycle", () => {
    it("should set and track private endpoint", () => {
      const router = createTestRouter();
      expect(router.hasPrivateEndpoint()).toBe(false);

      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-test-key",
        instanceId: 42,
        modelLabel: "Test Model",
      });

      expect(router.hasPrivateEndpoint()).toBe(true);
      const endpoint = router.getPrivateEndpoint();
      expect(endpoint).toEqual({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-test-key",
        instanceId: 42,
        modelLabel: "Test Model",
      });
    });

    it("should clear private endpoint", () => {
      const router = createTestRouter();
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-test-key",
        instanceId: 42,
        modelLabel: "Test Model",
      });

      router.clearPrivateEndpoint();
      expect(router.hasPrivateEndpoint()).toBe(false);
      expect(router.getPrivateEndpoint()).toBeUndefined();
    });

    it("should persist endpoint info to memory on set", () => {
      const router = createTestRouter();
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-test-key",
        instanceId: 42,
        modelLabel: "Test Model",
      });

      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenData = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenData);
      expect(parsed.lastPrivateEndpoint).toEqual({
        baseUrl: "https://llm.capix.network/v1",
        instanceId: 42,
        modelLabel: "Test Model",
      });
    });
  });

  describe("destroyPrivateLlm()", () => {
    it("should show info message when no private endpoint is active", async () => {
      const router = createTestRouter();
      await router.destroyPrivateLlm();

      expect(mockShowInfoMsg).toHaveBeenCalledWith("No private LLM endpoint active.");
    });

    it("should require user confirmation before destroying", async () => {
      const client = createMockClient();
      const router = new SmartRouterManager(client);
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-key",
        instanceId: 99,
        modelLabel: "Private Model",
      });

      mockShowWarnMsg.mockResolvedValue("Cancel");

      await router.destroyPrivateLlm();

      expect(client.delete).not.toHaveBeenCalled();
    });

    it("should call client.delete() with the correct path (not fetch with process.env.CAPIX_API_KEY)", async () => {
      const client = createMockClient({
        delete: vi.fn().mockResolvedValue({ ok: true }),
      });
      const router = new SmartRouterManager(client);
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-key",
        instanceId: 123,
        modelLabel: "Private Model",
      });

      mockShowWarnMsg.mockResolvedValue("Destroy");

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as any;

      const originalKey = process.env.CAPIX_API_KEY;
      process.env.CAPIX_API_KEY = "should-not-be-used";

      await router.destroyPrivateLlm();

      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.CAPIX_API_KEY;
      else process.env.CAPIX_API_KEY = originalKey;

      expect(client.delete).toHaveBeenCalledWith("/api/llm/123");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should clear endpoint and show success message on successful destroy", async () => {
      const client = createMockClient({
        delete: vi.fn().mockResolvedValue({ ok: true }),
      });
      const router = new SmartRouterManager(client);
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-key",
        instanceId: 77,
        modelLabel: "MyLlm",
      });

      mockShowWarnMsg.mockResolvedValue("Destroy");

      await router.destroyPrivateLlm();

      expect(router.hasPrivateEndpoint()).toBe(false);
      expect(mockShowInfoMsg).toHaveBeenCalledWith(expect.stringContaining("Destroyed MyLlm"));
    });

    it("should show error message and NOT clear endpoint on destroy failure", async () => {
      const client = createMockClient({
        delete: vi.fn().mockResolvedValue({ ok: false, error: "Server is down" }),
      });
      const router = new SmartRouterManager(client);
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-key",
        instanceId: 88,
        modelLabel: "FailModel",
      });

      mockShowWarnMsg.mockResolvedValue("Destroy");

      await router.destroyPrivateLlm();

      expect(router.hasPrivateEndpoint()).toBe(true);
      expect(mockShowErrorMsg).toHaveBeenCalledWith(
        expect.stringContaining("Failed to destroy LLM"),
      );
      expect(mockShowErrorMsg).toHaveBeenCalledWith(
        expect.stringContaining("Server is down"),
      );
      expect(mockShowErrorMsg).toHaveBeenCalledWith(
        expect.stringContaining("billing"),
      );
    });

    it("should show error message and NOT clear endpoint when client.delete throws", async () => {
      const client = createMockClient({
        delete: vi.fn().mockRejectedValue(new Error("Network timeout")),
      });
      const router = new SmartRouterManager(client);
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-key",
        instanceId: 99,
        modelLabel: "ThrowModel",
      });

      mockShowWarnMsg.mockResolvedValue("Destroy");

      await router.destroyPrivateLlm();

      expect(router.hasPrivateEndpoint()).toBe(true);
      expect(mockShowErrorMsg).toHaveBeenCalledWith(
        expect.stringContaining("Network timeout"),
      );
    });
  });

  describe("override tracking and learning", () => {
    it("should record override and update model ratings", () => {
      const router = createTestRouter();
      router.recordOverride("model-rejected", "model-chosen", "coding");

      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenData = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenData);
      expect(parsed.ratings["model-rejected"].coding.overrides).toBe(1);
      expect(parsed.ratings["model-chosen"].coding.selections).toBe(1);
    });

    it("should track overrides separately by task type", () => {
      const router = createTestRouter();
      router.recordOverride("model-a", "model-b", "reasoning");
      router.recordOverride("model-a", "model-b", "coding");

      const writtenData = mockWriteFileSync.mock.calls[1][1] as string;
      const parsed = JSON.parse(writtenData);
      expect(parsed.ratings["model-a"].reasoning.overrides).toBe(1);
      expect(parsed.ratings["model-a"].coding.overrides).toBe(1);
      expect(parsed.ratings["model-b"].reasoning.selections).toBe(1);
      expect(parsed.ratings["model-b"].coding.selections).toBe(1);
    });

    it("should block a model and prevent duplicate blocks", () => {
      const router = createTestRouter();
      router.blockModel("bad-model");
      router.blockModel("bad-model");

      expect(mockShowInfoMsg).toHaveBeenCalledTimes(1);
      expect(mockShowInfoMsg).toHaveBeenCalledWith(
        expect.stringContaining("blocked model 'bad-model'"),
      );
    });

    it("should favor a model and prevent duplicate favors", () => {
      const router = createTestRouter();
      router.favorModel("good-model");
      router.favorModel("good-model");

      expect(mockShowInfoMsg).toHaveBeenCalledTimes(1);
      expect(mockShowInfoMsg).toHaveBeenCalledWith(
        expect.stringContaining("favored model 'good-model'"),
      );
    });
  });

  describe("memory inspection", () => {
    it("should show routing mode in summary", () => {
      const router = createTestRouter();
      expect(router.getMemorySummary()).toContain("Routing mode: AUTO");
    });

    it("should show 'none' for private endpoint when not set", () => {
      const router = createTestRouter();
      expect(router.getMemorySummary()).toContain("Private endpoint: none");
    });

    it("should show model label when private endpoint is set", () => {
      const router = createTestRouter();
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-key",
        instanceId: 1,
        modelLabel: "CoolModel",
      });
      expect(router.getMemorySummary()).toContain("Private endpoint: CoolModel");
    });
  });

  describe("resetMemory()", () => {
    it("should clear all memory and private endpoint", () => {
      const router = createTestRouter();
      router.setPrivateEndpoint({
        baseUrl: "https://llm.capix.network/v1",
        apiKey: "sk-key",
        instanceId: 1,
        modelLabel: "Model1",
      });
      router.blockModel("blocked-model");
      router.favorModel("favored-model");

      router.resetMemory();

      expect(router.hasPrivateEndpoint()).toBe(false);
      const summary = router.getMemorySummary();
      expect(summary).toContain("Blocked: none");
      expect(summary).toContain("Favored: none");
    });
  });
});
