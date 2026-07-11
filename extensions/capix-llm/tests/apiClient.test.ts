import { describe, it, expect, beforeEach, vi } from "vitest";

const mockGetConfig = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: mockGetConfig,
  },
}));

import { CapixClient } from "../src/apiClient";

function createConfigMock(baseUrl = "https://capix.network") {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key === "baseUrl") return baseUrl;
      return defaultValue;
    }),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSecretStorage(token?: string) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === "capix.sessionToken") return token;
      return undefined;
    }),
    store: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CapixClient", () => {
  let client: CapixClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    globalThis.fetch = fetchMock as any;

    mockGetConfig.mockReturnValue(createConfigMock());
    client = new CapixClient();
  });

  describe("baseUrl", () => {
    it("ignores a workspace-controlled baseUrl", () => {
      mockGetConfig.mockReturnValue(createConfigMock("https://custom.capix.network"));
      expect(client.baseUrl).toBe("https://www.capix.network");
    });

    it("uses the compiled production origin", () => {
      expect(client.baseUrl).toBe(CapixClient.PRODUCTION_BASE_URL);
    });
  });

  describe("auth header generation", () => {
    it("should use the stored session token from SecretStorage, not process.env", async () => {
      delete process.env.CAPIX_API_KEY;
      const secretStorage = createMockSecretStorage("cpx_session.test-token-123");
      client.setSecretStorage(secretStorage);

      await client.get("/api/llm/models");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer cpx_session.test-token-123");
    });

    it("should NOT use process.env.CAPIX_API_KEY for auth", async () => {
      process.env.CAPIX_API_KEY = "should-not-be-used";
      const secretStorage = createMockSecretStorage("cpx_session.real-token");
      client.setSecretStorage(secretStorage);

      await client.get("/api/llm/models");

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer cpx_session.real-token");
      expect(headers.Authorization).not.toContain("should-not-be-used");

      delete process.env.CAPIX_API_KEY;
    });

    it("should return empty headers when no token is stored", async () => {
      const secretStorage = createMockSecretStorage(undefined);
      client.setSecretStorage(secretStorage);

      await client.get("/api/llm/models");

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });

    it("should cache the session token after first fetch from SecretStorage", async () => {
      const secretStorage = createMockSecretStorage("cpx_session.cached-token");
      client.setSecretStorage(secretStorage);

      await client.get("/api/llm/1");
      await client.get("/api/llm/2");

      expect(secretStorage.get).toHaveBeenCalledTimes(1);
    });
  });

  describe("isConfigured", () => {
    it("should return false when no token is loaded", () => {
      expect(client.isConfigured).toBe(false);
    });

    it("should return true after loading a valid cpx_session token", async () => {
      const secretStorage = createMockSecretStorage("cpx_session.valid-token");
      client.setSecretStorage(secretStorage);

      await client.checkConfigured();

      expect(client.isConfigured).toBe(true);
    });

    it("should return false for non-cpx_session tokens", async () => {
      const secretStorage = createMockSecretStorage("some-other-token");
      client.setSecretStorage(secretStorage);

      await client.checkConfigured();

      expect(client.isConfigured).toBe(false);
    });
  });

  describe("GET method", () => {
    it("should send a GET request with auth headers", async () => {
      const secretStorage = createMockSecretStorage("cpx_session.get-token");
      client.setSecretStorage(secretStorage);

      await client.get("/api/llm/models");

      expect(fetchMock).toHaveBeenCalledWith(
        "https://www.capix.network/api/llm/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer cpx_session.get-token",
          }),
        }),
      );
    });

    it("should use the correct path in the URL", async () => {
      await client.get("/api/cloud/billing");

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe("https://www.capix.network/api/cloud/billing");
    });

    it("should parse JSON response", async () => {
      const jsonResult = { ok: true, data: [1, 2, 3] };
      fetchMock.mockResolvedValue({
        json: vi.fn().mockResolvedValue(jsonResult),
      });

      const result = await client.get("/api/test");

      expect(result).toEqual(jsonResult);
    });
  });

  describe("POST method", () => {
    it("should send a POST request with auth headers and JSON body", async () => {
      const secretStorage = createMockSecretStorage("cpx_session.post-token");
      client.setSecretStorage(secretStorage);

      await client.post("/api/llm/deploy", { modelId: "test-model" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://www.capix.network/api/llm/deploy",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer cpx_session.post-token",
          }),
          body: JSON.stringify({ modelId: "test-model" }),
        }),
      );
    });

    it("should include auth headers on POST even without secret storage", async () => {
      await client.post("/api/cloud/instances/1", { action: "stop" });

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("DELETE method", () => {
    it("should send a DELETE request with auth headers", async () => {
      const secretStorage = createMockSecretStorage("cpx_session.delete-token");
      client.setSecretStorage(secretStorage);

      await client.delete("/api/llm/42");

      expect(fetchMock).toHaveBeenCalledWith(
        "https://www.capix.network/api/llm/42",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({
            Authorization: "Bearer cpx_session.delete-token",
          }),
        }),
      );
    });

    it("should not include the API key in the URL or body", async () => {
      process.env.CAPIX_API_KEY = "sk-leaked-key";
      const secretStorage = createMockSecretStorage("cpx_session.token");
      client.setSecretStorage(secretStorage);

      const deleteResult = await client.delete("/api/llm/99");

      const call = fetchMock.mock.calls[0];
      const url = call[0];
      const opts = call[1];

      expect(url).not.toContain("sk-leaked-key");
      expect(url).not.toContain("api_key");
      expect(opts.body).toBeUndefined();

      delete process.env.CAPIX_API_KEY;
    });

    it("should parse and return the JSON response", async () => {
      const jsonResult = { ok: true, message: "destroyed" };
      fetchMock.mockResolvedValue({
        json: vi.fn().mockResolvedValue(jsonResult),
      });

      const result = await client.delete<{ ok: boolean; message: string }>("/api/llm/1");

      expect(result).toEqual(jsonResult);
    });
  });

  describe("chat method", () => {
    it("should use the provided API key when passed", async () => {
      await client.chat(
        { messages: [{ role: "user", content: "hello" }] },
        "sk-chat-key",
      );

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer sk-chat-key");
    });

    it("should use session token auth when no API key is provided", async () => {
      const secretStorage = createMockSecretStorage("cpx_session.chat-token");
      client.setSecretStorage(secretStorage);

      await client.chat({ messages: [{ role: "user", content: "hello" }] });

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer cpx_session.chat-token");
    });

    it("should POST to the chat completions endpoint", async () => {
      await client.chat(
        { messages: [{ role: "user", content: "hi" }], model: "gpt-4" },
        "sk-key",
      );

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe("https://www.capix.network/api/v1/chat/completions");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe("gpt-4");
    });
  });

  describe("baseUrl trust boundary (W3-T3)", () => {
    it("ignores an insecure workspace override", () => {
      mockGetConfig.mockReturnValue(createConfigMock("http://insecure.capix.network"));
      expect(client.baseUrl).toBe("https://www.capix.network");
    });
  });

  describe("secret storage convenience methods", () => {
    it("getSecret should delegate to the secret storage", async () => {
      const secretStorage = createMockSecretStorage();
      secretStorage.get.mockResolvedValue("stored-secret-value");
      client.setSecretStorage(secretStorage);

      const result = await client.getSecret("capix.ai.apiKey");

      expect(result).toBe("stored-secret-value");
      expect(secretStorage.get).toHaveBeenCalledWith("capix.ai.apiKey");
    });

    it("storeSecret should delegate to the secret storage", async () => {
      const secretStorage = createMockSecretStorage();
      client.setSecretStorage(secretStorage);

      await client.storeSecret("capix.ai.apiKey", "sk-my-key");

      expect(secretStorage.store).toHaveBeenCalledWith("capix.ai.apiKey", "sk-my-key");
    });

    it("getSecret should return undefined when no secret storage is set", async () => {
      const result = await client.getSecret("any-key");
      expect(result).toBeUndefined();
    });
  });
});
