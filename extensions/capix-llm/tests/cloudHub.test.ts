/**
 * Tests for the Capix Cloud hub (`src/cloudHub.ts`) — the tabbed webview
 * that replaced the nine retired capix-cloud sidebar views.
 *
 * Covers the tab state model (default, valid switch, invalid switch, restored
 * tab validation) and the per-tab data mapping (deployments, instances, jobs,
 * API keys, models, account) that feeds the server-rendered tab bodies.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn();
    readonly fire = vi.fn();
    readonly dispose = vi.fn();
  },
}));
vi.mock('../src/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  CLOUD_HUB_TABS,
  createCloudHubState,
  isCloudHubTab,
  setHubTab,
  mapDeployments,
  mapInstances,
  instanceBadge,
  mapJobs,
  mapApiKeys,
  mapModels,
  mapAccount,
} from '../src/cloudHub';
import type { CatalogModel, HostedEndpoint, LlmDeploy } from '../src/types';

// ── Tab state model ─────────────────────────────────────────────────────────

describe('cloud hub tab state', () => {
  it('offers exactly the seven consolidated tabs in order', () => {
    expect(CLOUD_HUB_TABS.map((t) => t.id)).toEqual([
      'overview',
      'deployments',
      'instances',
      'jobs',
      'apikeys',
      'models',
      'account',
    ]);
  });

  it('defaults to the overview tab', () => {
    expect(createCloudHubState().activeTab).toBe('overview');
  });

  it('restores a persisted tab when it is a canonical id (getState/setState)', () => {
    expect(createCloudHubState('apikeys').activeTab).toBe('apikeys');
  });

  it('falls back to overview for a stale/unknown restored tab', () => {
    expect(createCloudHubState('capix.llm.deploys').activeTab).toBe('overview');
    expect(createCloudHubState(42).activeTab).toBe('overview');
    expect(createCloudHubState(undefined).activeTab).toBe('overview');
  });

  it('switches tabs for canonical ids only', () => {
    const state = createCloudHubState();
    expect(setHubTab(state, 'models').activeTab).toBe('models');
    // Invalid ids leave the state untouched (no crash, no fake tab).
    expect(setHubTab(state, 'bogus')).toBe(state);
  });

  it('isCloudHubTab guards every canonical id and rejects lookalikes', () => {
    for (const t of CLOUD_HUB_TABS) expect(isCloudHubTab(t.id)).toBe(true);
    expect(isCloudHubTab('Overview')).toBe(false);
    expect(isCloudHubTab('')).toBe(false);
    expect(isCloudHubTab(null)).toBe(false);
  });
});

// ── Deployments tab mapping ─────────────────────────────────────────────────

describe('mapDeployments', () => {
  const liveDeploy: LlmDeploy = {
    instanceId: 7,
    modelLabel: 'Qwen2.5 7B',
    state: 'running',
    endpoint: 'https://x.capix.network',
    ready: true,
    apiKey: 'ck-1',
    gpu: 'RTX 4090',
    location: 'eu',
    pricePerHr: 0.42,
  };

  it('maps a ready live deploy to a running row with the canonical record id', () => {
    const rows = mapDeployments([{ instance: { id: 'gpu_abc' }, live: liveDeploy }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instanceId: 7,
      modelLabel: 'Qwen2.5 7B',
      state: 'running',
      ready: true,
      instanceRecordId: 'gpu_abc',
    });
  });

  it('maps a booting live deploy to provisioning and synthesizes a record id', () => {
    const rows = mapDeployments([{ instance: {}, live: { ...liveDeploy, ready: false } }]);
    expect(rows[0].state).toBe('provisioning');
    expect(rows[0].instanceRecordId).toBe('llm-7');
  });

  it('keeps destroyed deploys after live ones and strips the LLM tier prefix', () => {
    const rows = mapDeployments([
      { instance: { id: 'gpu_dead', tier: 'LLM · Llama 3' }, live: null },
      { instance: { id: 'gpu_abc' }, live: liveDeploy },
    ]);
    expect(rows.map((r) => r.state)).toEqual(['running', 'destroyed']);
    expect(rows[1].modelLabel).toBe('Llama 3');
    expect(rows[1].instanceId).toBe(0);
  });
});

// ── Instances tab mapping ───────────────────────────────────────────────────

describe('mapInstances', () => {
  it('buckets statuses into display badges', () => {
    expect(instanceBadge('running')).toBe('active');
    expect(instanceBadge('provisioning')).toBe('provisioning');
    expect(instanceBadge('stopped')).toBe('stopped');
    expect(instanceBadge('terminated')).toBe('destroyed');
    expect(instanceBadge('weird')).toBe('unknown');
    expect(instanceBadge('')).toBe('unknown');
  });

  it('maps raw instances with their badges and rates', () => {
    const rows = mapInstances([
      {
        id: 'dep_1',
        tier: 'Capix Standard',
        status: 'running',
        startedAt: '2026-01-01',
        costUsdPerHour: 0.5,
      },
      { id: 'dep_2', tier: 'Capix Micro', status: 'stopped', costUsdPerHour: 0 },
    ]);
    expect(rows[0]).toMatchObject({ id: 'dep_1', badge: 'active', costUsdPerHour: 0.5 });
    expect(rows[1]).toMatchObject({ id: 'dep_2', badge: 'stopped' });
  });
});

// ── Jobs tab mapping ────────────────────────────────────────────────────────

describe('mapJobs', () => {
  it('maps known job shapes with status badges', () => {
    const rows = mapJobs([{ id: 'job_1', name: 'nightly-train', status: 'queued' }]);
    expect(rows).toEqual([{ id: 'job_1', name: 'nightly-train', status: 'queued' }]);
  });

  it('degrades defensively on partial/unknown shapes — never throws, never fakes', () => {
    const rows = mapJobs([{ jobId: 'j2', state: 'running' }, null, {}]);
    expect(rows[0]).toMatchObject({ id: 'j2', status: 'running' });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.id).toBeTruthy();
      expect(row.name).toBeTruthy();
      expect(row.status).toBeTruthy();
    }
  });

  it('maps an empty list to an empty list (the tab renders the empty state)', () => {
    expect(mapJobs([])).toEqual([]);
  });
});

// ── API keys tab mapping ────────────────────────────────────────────────────

describe('mapApiKeys', () => {
  it('maps portal keys with usage counts', () => {
    const rows = mapApiKeys([
      {
        id: 'k1',
        name: 'CI',
        keyPrefix: 'ck_live_ab',
        status: 'active',
        totalRequests: 120,
        lastUsedAt: '2026-07-01',
      },
    ]);
    expect(rows[0]).toEqual({
      id: 'k1',
      name: 'CI',
      keyPrefix: 'ck_live_ab',
      status: 'active',
      totalRequests: 120,
      lastUsedAt: '2026-07-01',
    });
  });

  it('coerces missing/garbage usage counts to zero', () => {
    const rows = mapApiKeys([{ id: 'k2', totalRequests: 'lots' }]);
    expect(rows[0].totalRequests).toBe(0);
    expect(rows[0].status).toBe('active');
  });
});

// ── Models tab mapping ──────────────────────────────────────────────────────

describe('mapModels', () => {
  const model = (over: Partial<CatalogModel>): CatalogModel => ({
    id: 'm',
    label: 'Model',
    family: 'f',
    category: 'chat',
    paramB: 7,
    minVramGb: 16,
    gpuCount: 1,
    maxModelLen: 4096,
    quantization: 'none',
    gated: false,
    tagline: '',
    description: '',
    ...over,
  });

  it('groups featured/supergemma apart from community models', () => {
    const groups = mapModels(
      [
        model({ id: 'sg', partner: 'supergemma' }),
        model({ id: 'feat', featured: true }),
        model({ id: 'comm' }),
      ],
      []
    );
    expect(groups.featured.map((m) => m.id)).toEqual(['sg', 'feat']);
    expect(groups.community.map((m) => m.id)).toEqual(['comm']);
  });

  it('passes hosted endpoints through untouched', () => {
    const hosted: HostedEndpoint[] = [
      {
        modelId: 'm',
        modelLabel: 'Hosted',
        baseUrl: 'https://x',
        region: 'us',
        healthy: true,
        isSuperGemma: false,
        apiKeyMasked: 'ck…',
      },
    ];
    expect(mapModels([], hosted).hosted).toEqual(hosted);
  });
});

// ── Account tab mapping ─────────────────────────────────────────────────────

describe('mapAccount', () => {
  it('maps balance, spend and ledger entries', () => {
    const a = mapAccount({
      balance: { usd: '12.50', sol: '0.1000', usdc: '12.50' },
      totalSpent: '100.00',
      activeInstances: 2,
      transactions: [{ type: 'topup', amount: '25.00', asset: 'USD' }],
    });
    expect(a).toMatchObject({
      balanceUsd: '12.50',
      balanceSol: '0.1000',
      balanceUsdc: '12.50',
      totalSpent: '100.00',
      activeInstances: 2,
    });
    expect(a.transactions).toEqual([{ kind: 'topup', amount: '25.00', asset: 'USD' }]);
  });

  it('defaults to zeroed balances — real zeros, not invented figures', () => {
    const a = mapAccount({});
    expect(a.balanceUsd).toBe('0.00');
    expect(a.totalSpent).toBe('0.00');
    expect(a.activeInstances).toBe(0);
    expect(a.transactions).toEqual([]);
  });

  it('caps ledger entries and labels unknown rows honestly', () => {
    const a = mapAccount({ transactions: Array.from({ length: 12 }, () => ({})) });
    expect(a.transactions).toHaveLength(8);
    expect(a.transactions[0].kind).toBe('Ledger entry');
  });
});
