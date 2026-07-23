import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetConfig } = vi.hoisted(() => ({ mockGetConfig: vi.fn() }));

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn();
    readonly fire = vi.fn();
    readonly dispose = vi.fn();
  },
  workspace: {
    getConfiguration: mockGetConfig,
  },
}));

import { CapixClient } from '../src/apiClient';

function createConfigMock(baseUrl = 'https://capix.network') {
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key === 'baseUrl') return baseUrl;
      return defaultValue;
    }),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSecretStorage(token?: string) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'capix.sessionToken') return token;
      return undefined;
    }),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CapixClient', () => {
  it('recognizes native OAuth access tokens as configured', async () => {
    const client = new CapixClient();
    client.setSecretStorage(createMockSecretStorage('cpxs_oauth-access-token'));
    expect(await client.checkConfigured()).toBe(true);
    expect(client.isConfigured).toBe(true);
  });

  it('publishes the stored OAuth token to native chat exactly once', async () => {
    const client = new CapixClient();
    client.setSecretStorage(createMockSecretStorage('cpxs_oauth-access-token'));
    const configureChat = vi.fn().mockResolvedValue(undefined);
    client.setOAuthAccessTokenHandler(configureChat);

    await client.checkConfigured();
    await client.checkConfigured();

    expect(configureChat).toHaveBeenCalledOnce();
    expect(configureChat).toHaveBeenCalledWith('cpxs_oauth-access-token');
  });

  it('resets only Capix OAuth secrets and clears published in-memory auth', async () => {
    const client = new CapixClient();
    const secrets = createMockSecretStorage('cpxs_stale-access-token');
    const publish = vi.fn().mockResolvedValue(undefined);
    client.setSecretStorage(secrets);
    client.setOAuthAccessTokenHandler(publish);
    await client.checkConfigured();

    await client.resetOAuthSession();

    expect(secrets.delete.mock.calls.map(([key]) => key).sort()).toEqual([
      'capix.refreshToken',
      'capix.sessionToken',
    ]);
    expect(client.isConfigured).toBe(false);
    expect(publish).toHaveBeenLastCalledWith(null);
  });
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

  describe('baseUrl', () => {
    it('ignores a workspace-controlled baseUrl', () => {
      mockGetConfig.mockReturnValue(createConfigMock('https://custom.capix.network'));
      expect(client.baseUrl).toBe('https://www.capix.network');
    });

    it('uses the compiled production origin', () => {
      expect(client.baseUrl).toBe(CapixClient.PRODUCTION_BASE_URL);
    });
  });

  describe('auth header generation', () => {
    it('should use the stored session token from SecretStorage, not process.env', async () => {
      delete process.env.CAPIX_API_KEY;
      const secretStorage = createMockSecretStorage('cpx_session.test-token-123');
      client.setSecretStorage(secretStorage);

      await client.get('/api/llm/models');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer cpx_session.test-token-123');
    });

    it('should NOT use process.env.CAPIX_API_KEY for auth', async () => {
      process.env.CAPIX_API_KEY = 'should-not-be-used';
      const secretStorage = createMockSecretStorage('cpx_session.real-token');
      client.setSecretStorage(secretStorage);

      await client.get('/api/llm/models');

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer cpx_session.real-token');
      expect(headers.Authorization).not.toContain('should-not-be-used');

      delete process.env.CAPIX_API_KEY;
    });

    it('should return empty headers when no token is stored', async () => {
      const secretStorage = createMockSecretStorage(undefined);
      client.setSecretStorage(secretStorage);

      await client.get('/api/llm/models');

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });

    it('should cache the session token after first fetch from SecretStorage', async () => {
      const secretStorage = createMockSecretStorage('cpx_session.cached-token');
      client.setSecretStorage(secretStorage);

      await client.get('/api/llm/1');
      await client.get('/api/llm/2');

      expect(secretStorage.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('isConfigured', () => {
    it('should return false when no token is loaded', () => {
      expect(client.isConfigured).toBe(false);
    });

    it('should return true after loading a valid cpx_session token', async () => {
      const secretStorage = createMockSecretStorage('cpx_session.valid-token');
      client.setSecretStorage(secretStorage);

      await client.checkConfigured();

      expect(client.isConfigured).toBe(true);
    });

    it('should return false for non-cpx_session tokens', async () => {
      const secretStorage = createMockSecretStorage('some-other-token');
      client.setSecretStorage(secretStorage);

      await client.checkConfigured();

      expect(client.isConfigured).toBe(false);
    });
  });

  describe('GET method', () => {
    it('should send a GET request with auth headers', async () => {
      const secretStorage = createMockSecretStorage('cpx_session.get-token');
      client.setSecretStorage(secretStorage);

      await client.get('/api/llm/models');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.capix.network/api/llm/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer cpx_session.get-token',
          }),
        })
      );
    });

    it('should use the correct path in the URL', async () => {
      await client.get('/api/v1/billing');

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe('https://www.capix.network/api/v1/billing');
    });

    it('should parse JSON response', async () => {
      const jsonResult = { ok: true, data: [1, 2, 3] };
      fetchMock.mockResolvedValue({
        json: vi.fn().mockResolvedValue(jsonResult),
      });

      const result = await client.get('/api/test');

      expect(result).toEqual(jsonResult);
    });
  });

  describe('POST method', () => {
    it('should send a POST request with auth headers and JSON body', async () => {
      const secretStorage = createMockSecretStorage('cpx_session.post-token');
      client.setSecretStorage(secretStorage);

      await client.post('/api/llm/deploy', { modelId: 'test-model' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.capix.network/api/llm/deploy',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer cpx_session.post-token',
          }),
          body: JSON.stringify({ modelId: 'test-model' }),
        })
      );
    });

    it('should include auth headers on POST even without secret storage', async () => {
      await client.post('/api/cloud/instances/1', { action: 'stop' });

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('DELETE method', () => {
    it('should send a DELETE request with auth headers', async () => {
      const secretStorage = createMockSecretStorage('cpx_session.delete-token');
      client.setSecretStorage(secretStorage);

      await client.delete('/api/llm/42');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.capix.network/api/llm/42',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: 'Bearer cpx_session.delete-token',
          }),
        })
      );
    });

    it('should not include the API key in the URL or body', async () => {
      process.env.CAPIX_API_KEY = 'sk-leaked-key';
      const secretStorage = createMockSecretStorage('cpx_session.token');
      client.setSecretStorage(secretStorage);

      const deleteResult = await client.delete('/api/llm/99');

      const call = fetchMock.mock.calls[0];
      const url = call[0];
      const opts = call[1];

      expect(url).not.toContain('sk-leaked-key');
      expect(url).not.toContain('api_key');
      expect(opts.body).toBeUndefined();

      delete process.env.CAPIX_API_KEY;
    });

    it('should parse and return the JSON response', async () => {
      const jsonResult = { ok: true, message: 'destroyed' };
      fetchMock.mockResolvedValue({
        json: vi.fn().mockResolvedValue(jsonResult),
      });

      const result = await client.delete<{ ok: boolean; message: string }>('/api/llm/1');

      expect(result).toEqual(jsonResult);
    });
  });

  describe('chat method', () => {
    it('should use the provided API key when passed', async () => {
      await client.chat({ messages: [{ role: 'user', content: 'hello' }] }, 'sk-chat-key');

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer sk-chat-key');
    });

    it('should use session token auth when no API key is provided', async () => {
      const secretStorage = createMockSecretStorage('cpx_session.chat-token');
      client.setSecretStorage(secretStorage);

      await client.chat({ messages: [{ role: 'user', content: 'hello' }] });

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer cpx_session.chat-token');
    });

    it('should POST to the chat completions endpoint', async () => {
      await client.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4' }, 'sk-key');

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe('https://www.capix.network/api/v1/chat/completions');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4');
    });
  });

  describe('baseUrl trust boundary (W3-T3)', () => {
    it('ignores an insecure workspace override', () => {
      mockGetConfig.mockReturnValue(createConfigMock('http://insecure.capix.network'));
      expect(client.baseUrl).toBe('https://www.capix.network');
    });
  });

  describe('secret storage convenience methods', () => {
    it('reuses a deployment SSH credential from OS SecretStorage', async () => {
      const credential = {
        host: '203.0.113.10',
        port: 22,
        privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        filename: 'dep_1.pem',
      };
      const secrets = new Map([['capix.ssh.dep_1', JSON.stringify(credential)]]);
      client.setSecretStorage({
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        }),
      });

      await expect(client.getStoredSshCredential('dep_1')).resolves.toEqual(credential);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stores a first-use SSH credential in OS SecretStorage', async () => {
      const secrets = new Map<string, string>([['capix.sessionToken', 'cpxs_session']]);
      const storage = {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        }),
      };
      client.setSecretStorage(storage);
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: {
          get: (name: string) =>
            (
              ({
                'content-type': 'application/x-pem-file',
                'x-capix-ssh-host': '203.0.113.10',
                'x-capix-ssh-port': '22',
                'x-capix-ssh-filename': 'dep_1.pem',
              }) as Record<string, string>
            )[name.toLowerCase()] ?? null,
        },
        text: vi
          .fn()
          .mockResolvedValue('-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'),
      });

      const credential = await client.getStoredSshCredential('dep_1');

      expect(credential.host).toBe('203.0.113.10');
      expect(JSON.parse(secrets.get('capix.ssh.dep_1')!)).toEqual(credential);
    });

    it('rotates an expired SSH credential only after the replacement was installed', async () => {
      const secrets = new Map<string, string>([
        ['capix.sessionToken', 'cpxs_session'],
        [
          'capix.ssh.dep_1',
          JSON.stringify({ host: 'old', port: 22, privateKey: '-----BEGIN PRIVATE KEY-----\nold' }),
        ],
      ]);
      const storage = {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        }),
      };
      client.setSecretStorage(storage);
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({ rotated: true, oldKeyRevokedOnInstance: true }),
      });

      await expect(client.rotateSshCredential('dep_1')).resolves.toEqual({
        rotated: true,
        oldKeyRevokedOnInstance: true,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://www.capix.network/api/v1/deployments/dep_1/ssh/rotate'
      );
      expect(storage.delete).toHaveBeenCalledWith('capix.ssh.dep_1');
    });

    it('does not accept a replacement SSH key that was not installed', async () => {
      client.setSecretStorage(createMockSecretStorage('cpxs_session'));
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({ rotated: true, oldKeyRevokedOnInstance: false }),
      });

      await expect(client.rotateSshCredential('dep_1')).rejects.toMatchObject({ status: 409 });
    });

    it('lists deployments from the canonical owner-scoped GPU saga endpoint', async () => {
      client.setSecretStorage(createMockSecretStorage('cpxs_session'));
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi
          .fn()
          .mockResolvedValue({
            ok: true,
            sagas: [
              {
                sagaId: 'gpu_1',
                state: 'ALLOCATING',
                assetId: null,
                workload: 'llm',
                modelId: 'supergemma',
                expiresAt: '2026-07-12T00:00:00.000Z',
                createdAt: '2026-07-11T00:00:00.000Z',
              },
            ],
          }),
      });
      const result = await client.listDeploys();
      expect(fetchMock.mock.calls[0][0]).toBe('https://www.capix.network/api/v1/gpu');
      expect(result.deploys[0]).toMatchObject({
        instance: { id: 'gpu_1' },
        live: { instanceId: 0, modelLabel: 'supergemma', state: 'loading' },
      });
    });
    it('rotates a refresh token after a cold-start 401 and retries once', async () => {
      const secrets = new Map([
        ['capix.sessionToken', 'cpxs_expired'],
        ['capix.refreshToken', 'cpxsr_old'],
      ]);
      const storage = {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
      };
      client.setSecretStorage(storage);
      fetchMock
        .mockResolvedValueOnce({
          status: 401,
          ok: false,
          json: vi.fn().mockResolvedValue({ error: 'unauthorized' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: vi.fn().mockResolvedValue({ access_token: 'cpxs_new', refresh_token: 'cpxsr_new' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true }),
        });

      await expect(client.get('/api/v1/account')).resolves.toEqual({ ok: true });
      expect(secrets.get('capix.sessionToken')).toBe('cpxs_new');
      expect(secrets.get('capix.refreshToken')).toBe('cpxsr_new');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('single-flights refresh when profile and cloud requests receive 401 together', async () => {
      const secrets = new Map([
        ['capix.sessionToken', 'cpxs_expired'],
        ['capix.refreshToken', 'cpxsr_old'],
      ]);
      client.setSecretStorage({
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        }),
      });
      let refreshCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/oauth/token')) {
          refreshCalls += 1;
          return {
            status: 200,
            ok: true,
            json: vi
              .fn()
              .mockResolvedValue({ access_token: 'cpxs_new', refresh_token: 'cpxsr_new' }),
          };
        }
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth === 'Bearer cpxs_expired') {
          return {
            status: 401,
            ok: false,
            json: vi.fn().mockResolvedValue({ error: 'unauthorized' }),
          };
        }
        return { status: 200, ok: true, json: vi.fn().mockResolvedValue({ ok: true, data: [] }) };
      });

      await Promise.all([
        client.get('/api/v1/billing'),
        client.get('/api/v1/deployments?limit=100'),
      ]);

      expect(refreshCalls).toBe(1);
      expect(secrets.get('capix.sessionToken')).toBe('cpxs_new');
    });

    it('coalesces identical in-flight GET requests from concurrent views', async () => {
      let resolveResponse!: (value: unknown) => void;
      fetchMock.mockReturnValue(
        new Promise((resolve) => {
          resolveResponse = resolve;
        })
      );

      const first = client.get('/api/v1/billing');
      const second = client.get('/api/v1/billing');
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledOnce();
      resolveResponse({ status: 200, ok: true, json: vi.fn().mockResolvedValue({ ok: true }) });

      await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    });

    it('lists instances from canonical deployments instead of retired billing payloads', async () => {
      client.setSecretStorage(createMockSecretStorage('cpxs_session'));
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'dep_1',
              phase: 'RUNNING',
              createdAt: '2026-07-12T00:00:00.000Z',
              workloadSpec: { kind: 'cpu', name: 'Customer VM' },
              allocations: [{ id: 'alloc_1', region: 'eu', sshAvailable: true }],
            },
          ],
        }),
      });

      const result = await client.listInstances();

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://www.capix.network/api/v1/deployments?limit=100'
      );
      expect(result.instances[0]).toMatchObject({
        id: 'dep_1',
        tier: 'Customer VM',
        status: 'running',
      });
      expect(result.instances[0].nodes[0]).toMatchObject({
        nodeId: 'alloc_1',
        location: 'eu',
        sshAvailable: true,
        sshHost: null,
      });
    });

    it('recovers when another IDE window wins refresh-token rotation', async () => {
      const secrets = new Map([
        ['capix.sessionToken', 'cpxs_expired'],
        ['capix.refreshToken', 'cpxsr_old'],
      ]);
      const storage = {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
      };
      client.setSecretStorage(storage);
      fetchMock
        .mockResolvedValueOnce({
          status: 401,
          ok: false,
          json: vi.fn().mockResolvedValue({ error: 'unauthorized' }),
        })
        .mockImplementationOnce(async () => {
          // Simulate a different extension host completing rotation while this
          // request was in flight and receiving invalid_grant for the old token.
          secrets.set('capix.sessionToken', 'cpxs_rotated_elsewhere');
          secrets.set('capix.refreshToken', 'cpxsr_rotated_elsewhere');
          return {
            status: 400,
            ok: false,
            json: vi.fn().mockResolvedValue({ error: 'invalid_grant' }),
          };
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true }),
        });

      await expect(client.get('/api/v1/billing')).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>).Authorization).toBe(
        'Bearer cpxs_rotated_elsewhere'
      );
    });

    it('surfaces an unauthorized API response instead of treating it as billing data', async () => {
      const storage = createMockSecretStorage('cpxs_expired');
      const publish = vi.fn().mockResolvedValue(undefined);
      client.setSecretStorage(storage);
      client.setOAuthAccessTokenHandler(publish);
      fetchMock.mockResolvedValue({
        status: 401,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'unauthorized' }),
      });
      await expect(client.get('/api/v1/billing')).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      });
      expect(storage.delete).toHaveBeenCalledWith('capix.sessionToken');
      expect(publish).toHaveBeenCalledWith(null);
      expect(client.isConfigured).toBe(false);
    });

    it('getSecret should delegate to the secret storage', async () => {
      const secretStorage = createMockSecretStorage();
      secretStorage.get.mockResolvedValue('stored-secret-value');
      client.setSecretStorage(secretStorage);

      const result = await client.getSecret('capix.ai.apiKey');

      expect(result).toBe('stored-secret-value');
      expect(secretStorage.get).toHaveBeenCalledWith('capix.ai.apiKey');
    });

    it('storeSecret should delegate to the secret storage', async () => {
      const secretStorage = createMockSecretStorage();
      client.setSecretStorage(secretStorage);

      await client.storeSecret('capix.ai.apiKey', 'sk-my-key');

      expect(secretStorage.store).toHaveBeenCalledWith('capix.ai.apiKey', 'sk-my-key');
    });

    it('getSecret should return undefined when no secret storage is set', async () => {
      const result = await client.getSecret('any-key');
      expect(result).toBeUndefined();
    });
  });
});
