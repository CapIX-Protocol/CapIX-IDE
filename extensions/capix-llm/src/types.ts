/**
 * Capix LLM Extension — shared types.
 * Mirrors the shapes returned by the capix.network /api/llm/* routes.
 */

export interface CatalogModel {
  id: string;
  label: string;
  family: string;
  category: "chat" | "coding" | "reasoning" | "vision";
  paramB: number;
  minVramGb: number;
  gpuCount: number;
  maxModelLen: number;
  quantization: string;
  gated: boolean;
  tagline: string;
  description: string;
  popular?: boolean;
  badge?: string;
  partner?: string;
  featured?: boolean;
}

export interface GpuOffer {
  askId: number;
  gpu: string;
  numGpus: number;
  vramGb: number;
  totalVramGb: number;
  cpuCores: number;
  ramGb: number;
  pricePerHr: number;
  roundedPricePerHr: number;
  location: string;
  reliability: number;
}

export interface LlmDeploy {
  instanceId: number;
  modelLabel: string;
  state: "loading" | "running" | "stopped" | "unknown";
  endpoint: string | null;
  ready: boolean;
  apiKey: string | null;
  gpu: string;
  location: string;
  pricePerHr: number;
}

export interface HostedEndpoint {
  modelId: string;
  modelLabel: string;
  baseUrl: string;
  region: string;
  healthy: boolean;
  isSuperGemma: boolean;
  apiKeyMasked: string;
}

export interface DeployResult {
  ok: boolean;
  instanceId: number;
  label: string;
  apiKey: string;
  model: { id: string; label: string; maxModelLen: number };
  gpu: string;
  location: string;
  pricePerHr: number;
  chargedUsd: number;
  endpoint: string | null;
}
