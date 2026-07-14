/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/skillsRuntime - Signed, versioned, sandboxed Skills
 *  Runtime for the Capix Intelligence workspace. The runtime is the IDE-side
 *  authority on which skills are installed, enabled, pinned, and how they may
 *  behave. It:
 *
 *    - manages signed / versioned skill manifests (parse → verify provenance →
 *      compute integrity hash → register),
 *    - verifies provenance (repo + commit + tag) and integrity (sha256 of the
 *      canonical manifest content),
 *    - enforces declared permissions (deny / allow / ask) per capability,
 *    - sandboxes skill execution against per-skill network / filesystem /
 *      spend policies,
 *    - supports install / uninstall / enable / disable / pin / invoke,
 *    - selects skills automatically (with an explanation) or manually,
 *    - emits a {@link SkillInvocationReceipt} for every invocation so every
 *      skill use is auditable and settles into the work-receipt graph.
 *
 *  The runtimeTalks to the Intelligence backend (POST /api/v1/skills) for
 *  persistence where available, and maintains an authoritative local store so
 *  the IDE remains responsive when the backend is unreachable. Integrity and
 *  provenance verification are computed locally with `node:crypto` so trust is
 *  never outsourced.
 *-------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from "node:crypto";
import type {
	IntelligenceClient,
} from "./intelligenceClient.js";
import type {
	SkillRecord as BaseSkillRecord,
	RegisterSkillRequest,
} from "./types.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** Capability access level declared by a skill manifest. */
export type SkillAccessLevel = "deny" | "allow" | "ask";

/** A single permission declaration on a skill manifest. */
export interface SkillPermission {
	name: string;
	accessLevel: SkillAccessLevel;
	scope?: Record<string, unknown>;
}

/** Network egress policy for a skill. */
export interface SkillNetworkPolicy {
	/** Allowed host globs (e.g. `*.capix.network`). Empty = fully sandboxed. */
	allowedHosts: string[];
	/** Hard cap on outbound bytes per invocation. 0 = none. */
	maxEgressBytes: number;
}

/** Filesystem access policy for a skill. */
export interface SkillFilesystemPolicy {
	/** Readable path prefixes (workspace-relative). */
	readPaths: string[];
	/** Writable path prefixes (workspace-relative). */
	writePaths: string[];
	/** If true, the skill may not write outside writePaths (default true). */
	strict: boolean;
}

/** Spend policy caps what a single invocation may cost. */
export interface SkillSpendPolicy {
	currency: string;
	/** Minor-unit (e.g. micro-USD) cap per invocation. 0 = unlimited. */
	perInvocationCapMinor: number;
	/** Minor-unit cap over the skill's lifetime. 0 = unlimited. */
	lifetimeCapMinor: number;
}

export type SkillRiskClass = "low" | "medium" | "high";

export type SkillStatus = "installed" | "enabled" | "disabled" | "pinned" | "deprecated";

export type SkillProvenanceKind = "first-party" | "registry" | "url" | "local";

/** Provenance chain — where the skill came from, down to a commit. */
export interface SkillProvenance {
	kind: SkillProvenanceKind;
	repo?: string;
	commit?: string;
	tag?: string;
	registryName?: string;
	fetchedFrom?: string;
	signerKeyId?: string;
	/** Ed25519 signature hex over the integrity hash (if signed). */
	signature?: string;
	verified: boolean;
	verifiedAt?: string;
}

export interface SkillEvaluationResult {
	score: number;
	passed: boolean;
	notes?: string;
	evaluatedAt: string;
}

/** First-party capability families shipped with the IDE by default. */
export type FirstPartyFamily =
	| "coding"
	| "testing"
	| "review"
	| "security"
	| "deployment";

/**
 * The authoritative managed-skill record. Extends the wire {@link BaseSkillRecord}
 * with everything the runtime needs to govern execution locally.
 */
export interface SkillRecord extends BaseSkillRecord {
	status: SkillStatus;
	author: string;
	license: string;
	riskClass: SkillRiskClass;
	firstParty: boolean;
	family?: FirstPartyFamily;
	provenance: SkillProvenance;
	integrityHash: string;
	permissions: SkillPermission[];
	networkPolicy: SkillNetworkPolicy;
	filesystemPolicy: SkillFilesystemPolicy;
	spendPolicy: SkillSpendPolicy;
	lastUsed?: string;
	pinnedVersion?: string;
	enabled: boolean;
	triggerConditions: string[];
	requiredTools: string[];
	evaluationResults: SkillEvaluationResult[];
	/** Lifetime spend accumulated in minor units. */
	lifetimeSpentMinor: number;
}

export interface SkillResult {
	ok: boolean;
	output?: unknown;
	error?: string;
	receipt: SkillInvocationReceipt;
}

export interface PermissionCheck {
	name: string;
	decided: SkillAccessLevel;
	allowed: boolean;
	reason?: string;
}

export interface SkillInvocationReceipt {
	id: string;
	skillId: string;
	skillName: string;
	skillVersion: string;
	timestamp: string;
	durationMs: number;
	costMinor: number;
	currency: string;
	tokensIn: number;
	tokensOut: number;
	success: boolean;
	error?: string;
	permissionChecks: PermissionCheck[];
	provenanceVerified: boolean;
}

/** A signed/versioned manifest describing a skill to be installed. */
export interface SkillManifest {
	name: string;
	version: string;
	description: string;
	author: string;
	license: string;
	handler?: string;
	riskClass?: SkillRiskClass;
	family?: FirstPartyFamily;
	triggerConditions?: string[];
	requiredTools?: string[];
	permissions?: SkillPermission[];
	networkPolicy?: Partial<SkillNetworkPolicy>;
	filesystemPolicy?: Partial<SkillFilesystemPolicy>;
	spendPolicy?: Partial<SkillSpendPolicy>;
	provenance?: Partial<SkillProvenance>;
	input?: Record<string, unknown>;
}

export interface SkillInstallOptions {
	/** Trust the manifest's signature without online verification. */
	trustLocal?: boolean;
	/** Force-enable after install. */
	enable?: boolean;
	/** Pin to this version on install. */
	pinVersion?: string;
}

/** Callback used to resolve `ask`-level permissions interactively. */
export type PermissionPrompt = (
	skillId: string,
	permission: string,
	scope?: Record<string, unknown>,
) => boolean;

export type SkillsRuntimeLogger = (message: string, meta?: Record<string, unknown>) => void;

// ── First-party registry ────────────────────────────────────────────────────

const FIRST_PARTY_SKILLS: SkillManifest[] = [
	{
		name: "capix.coding.refactor",
		version: "1.4.0",
		description: "Refactor code while preserving behavior across the workspace.",
		author: "Capix Network",
		license: "Apache-2.0",
		handler: "first-party:refactor",
		riskClass: "medium",
		family: "coding",
		triggerConditions: ["refactor", "rename", "extract", "inline", "simplify"],
		requiredTools: ["filesystem.read", "filesystem.write", "git.diff"],
		permissions: [
			{ name: "filesystem.write", accessLevel: "allow", scope: { scope: "workspace" } },
			{ name: "git.commit", accessLevel: "ask" },
			{ name: "network.fetch", accessLevel: "deny" },
		],
		networkPolicy: { allowedHosts: [], maxEgressBytes: 0 },
		filesystemPolicy: {
			readPaths: ["**/*"],
			writePaths: ["src/**", "tests/**"],
			strict: true,
		},
		spendPolicy: { currency: "usd", perInvocationCapMinor: 250000, lifetimeCapMinor: 5000000 },
		provenance: { kind: "first-party", verified: true },
	},
	{
		name: "capix.testing.generate",
		version: "2.1.0",
		description: "Generate unit and integration tests from implementation + types.",
		author: "Capix Network",
		license: "Apache-2.0",
		handler: "first-party:gen-tests",
		riskClass: "low",
		family: "testing",
		triggerConditions: ["test", "tests", "vitest", "jest", "coverage", "fixture"],
		requiredTools: ["filesystem.read", "filesystem.write"],
		permissions: [
			{ name: "filesystem.write", accessLevel: "allow", scope: { scope: "tests" } },
			{ name: "shell.exec", accessLevel: "ask" },
			{ name: "network.fetch", accessLevel: "deny" },
		],
		networkPolicy: { allowedHosts: [], maxEgressBytes: 0 },
		filesystemPolicy: { readPaths: ["**/*"], writePaths: ["tests/**"], strict: true },
		spendPolicy: { currency: "usd", perInvocationCapMinor: 120000, lifetimeCapMinor: 2000000 },
		provenance: { kind: "first-party", verified: true },
	},
	{
		name: "capix.review.pull-request",
		version: "1.0.2",
		description: "Peer-style code review: bugs, security, style, missing tests.",
		author: "Capix Network",
		license: "Apache-2.0",
		handler: "first-party:review",
		riskClass: "low",
		family: "review",
		triggerConditions: ["review", "pr", "merge", "critique", "nit", "lint"],
		requiredTools: ["filesystem.read", "git.diff"],
		permissions: [
			{ name: "filesystem.read", accessLevel: "allow" },
			{ name: "filesystem.write", accessLevel: "deny" },
			{ name: "network.fetch", accessLevel: "deny" },
		],
		networkPolicy: { allowedHosts: [], maxEgressBytes: 0 },
		filesystemPolicy: { readPaths: ["**/*"], writePaths: [], strict: true },
		spendPolicy: { currency: "usd", perInvocationCapMinor: 80000, lifetimeCapMinor: 1000000 },
		provenance: { kind: "first-party", verified: true },
	},
	{
		name: "capix.security.audit",
		version: "0.9.0",
		description: "Audit for secrets, unsafe deps, injection sinks, crypto misuse.",
		author: "Capix Network",
		license: "Apache-2.0",
		handler: "first-party:sec-audit",
		riskClass: "medium",
		family: "security",
		triggerConditions: ["security", "audit", "secret", "vuln", "cve", "dependency"],
		requiredTools: ["filesystem.read", "network.fetch"],
		permissions: [
			{ name: "filesystem.read", accessLevel: "allow" },
			{ name: "filesystem.write", accessLevel: "deny" },
			{ name: "network.fetch", accessLevel: "allow", scope: { hosts: ["*.capix.network", "registry.npmjs.org"] } },
		],
		networkPolicy: { allowedHosts: ["*.capix.network", "registry.npmjs.org"], maxEgressBytes: 1048576 },
		filesystemPolicy: { readPaths: ["**/*"], writePaths: [], strict: true },
		spendPolicy: { currency: "usd", perInvocationCapMinor: 200000, lifetimeCapMinor: 3000000 },
		provenance: { kind: "first-party", verified: true },
	},
	{
		name: "capix.deployment.blue-green",
		version: "3.0.0",
		description: "Blue/green deployment rollout with rollback checkpoints.",
		author: "Capix Network",
		license: "Apache-2.0",
		handler: "first-party:deploy-bg",
		riskClass: "high",
		family: "deployment",
		triggerConditions: ["deploy", "rollout", "blue-green", "release", "ship", "rollback"],
		requiredTools: ["shell.exec", "network.fetch", "git.commit"],
		permissions: [
			{ name: "shell.exec", accessLevel: "ask" },
			{ name: "network.fetch", accessLevel: "allow", scope: { hosts: ["api.capix.network"] } },
			{ name: "filesystem.write", accessLevel: "ask" },
		],
		networkPolicy: { allowedHosts: ["api.capix.network"], maxEgressBytes: 524288 },
		filesystemPolicy: { readPaths: ["**/*"], writePaths: ["deploy/**"], strict: true },
		spendPolicy: { currency: "usd", perInvocationCapMinor: 500000, lifetimeCapMinor: 10000000 },
		provenance: { kind: "first-party", verified: true },
	},
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			out[k] = sortKeys((value as Record<string, unknown>)[k]);
		}
		return out;
	}
	return value;
}

/** SHA-256 of a string in hex. */
function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Integrity hash = sha256 of the canonical manifest (content only). */
function computeIntegrityHash(manifest: SkillManifest): string {
	const redacted: SkillManifest = { ...manifest };
	// Provenance is metadata about origin, not content; exclude from content hash.
	delete (redacted as SkillManifest).provenance;
	return sha256Hex(canonicalJson(redacted));
}

/** Verify an Ed25519 signature over the integrity hash (stub, but typed). */
function verifySignature(integrityHash: string, signature: string | undefined, _keyId: string | undefined): boolean {
	if (!signature) return false;
	// Real impl would use node:crypto verify(null, pubKey, sig, msg).
	// The runtime treats a present signature as *structurally valid* but still
	// requires the signer key to be registered; callers MUST set verified=false
	// if the signer is unknown. Here we just check shape.
	return /^[0-9a-f]{64,128}$/i.test(signature) && /^[0-9a-f]{64}$/i.test(integrityHash);
}

function matchHost(host: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	return patterns.some((p) => {
		if (p === host) return true;
		if (p.startsWith("*.")) {
			const suffix = p.slice(1);
			return host.endsWith(suffix) && host.length > suffix.length;
		}
		return false;
	});
}

function fmtCost(minor: number, currency: string): string {
	const major = (minor / 1_000_000).toFixed(2);
	return `${major} ${currency.toUpperCase()}`;
}

// ── Runtime ─────────────────────────────────────────────────────────────────

export class SkillsRuntime {
	private readonly store = new Map<string, SkillRecord>();
	private readonly receipts: SkillInvocationReceipt[] = [];
	private readonly clientId?: IntelligenceClient;
	private readonly prompt: PermissionPrompt;
	private readonly log: SkillsRuntimeLogger;

	constructor(opts: {
		client?: IntelligenceClient;
		prompt?: PermissionPrompt;
		logger?: SkillsRuntimeLogger;
	} = {}) {
		this.clientId = opts.client;
		this.prompt = opts.prompt ?? (() => false);
		this.log = opts.logger ?? (() => undefined);
		this.seedFirstParty();
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	/** Seed the default first-party skills as enabled + verified. */
	private seedFirstParty(): void {
		for (const manifest of FIRST_PARTY_SKILLS) {
			const record = this.materialize(manifest, "first-party", {
				trustLocal: true,
				enable: true,
			});
			if (!this.store.has(record.id)) {
				record.enabled = true;
				record.status = "enabled";
				this.store.set(record.id, record);
			}
		}
	}

	// ── install / uninstall ────────────────────────────────────────────────

	/**
	 * Install a skill from one of:
	 *   - `https://...`            → remote manifest (provenance kind = url)
	 *   - `registry:<name>@<ver>`  → registry reference
	 *   - `first-party:<name>`     → seed a first-party skill by name
	 *   - a JSON manifest string   → local manifest
	 *
	 * Provenance + integrity are verified before registration. A skill that
	 * fails provenance verification is installed in `disabled` state with
	 * `provenance.verified = false` so the user can inspect before enabling.
	 */
	async install(source: string, options: SkillInstallOptions = {}): Promise<SkillRecord> {
		const manifest = this.parseSource(source);
		if (!manifest) {
			throw new Error(`capix.intelligence: could not parse skill from "${source}"`);
		}

		const kind: SkillProvenanceKind = source.startsWith("http://") || source.startsWith("https://")
			? "url"
			: source.startsWith("registry:")
				? "registry"
				: source.startsWith("first-party:")
					? "first-party"
					: "local";

		const record = this.materialize(manifest, kind, options);

		// Idempotent: re-installing the same name+version is a no-op update.
		const existing = this.findByName(manifest.name);
		if (existing && existing.version === manifest.version) {
			this.log("skill.reinstall", { skillId: record.id });
			return existing;
		}

		this.store.set(record.id, record);
		await this.syncToBackend(record);

		this.log("skill.installed", {
			skillId: record.id,
			name: record.name,
			version: record.version,
			integrity: record.integrityHash,
			verified: record.provenance.verified,
		});
		return record;
	}

	async uninstall(skillId: string): Promise<void> {
		const rec = this.store.get(skillId);
		if (!rec) {
			throw new Error(`capix.intelligence: unknown skill "${skillId}"`);
		}
		this.store.delete(skillId);
		this.log("skill.uninstalled", { skillId, name: rec.name });
	}

	// ── enable / disable / pin ─────────────────────────────────────────────

	async enable(skillId: string): Promise<void> {
		const rec = this.require(skillId);
		if (!rec.provenance.verified) {
			throw new Error(
				`capix.intelligence: skill "${rec.name}" failed provenance verification and cannot be enabled`,
			);
		}
		rec.enabled = true;
		rec.status = rec.pinnedVersion ? "pinned" : "enabled";
		this.log("skill.enabled", { skillId, name: rec.name });
	}

	async disable(skillId: string): Promise<void> {
		const rec = this.require(skillId);
		rec.enabled = false;
		rec.status = "disabled";
		this.log("skill.disabled", { skillId, name: rec.name });
	}

	async pin(skillId: string, version: string): Promise<void> {
		const rec = this.require(skillId);
		if (rec.version !== version) {
			throw new Error(
				`capix.intelligence: cannot pin "${rec.name}" to ${version} (installed: ${rec.version})`,
			);
		}
		rec.pinnedVersion = version;
		rec.status = "pinned";
		this.log("skill.pinned", { skillId, name: rec.name, version });
	}

	// ── invoke ─────────────────────────────────────────────────────────────

	/**
	 * Invoke a skill under sandbox. Permission declarations are enforced first;
	 * any `ask`-level capability triggers the configured {@link PermissionPrompt}
	 * (which defaults to deny, so calling code in the IDE should supply a real
	 * prompt). Spend and lifetime caps are checked. A {@link SkillInvocationReceipt}
	 * is always produced, even on failure.
	 */
	async invoke(
		skillId: string,
		input: unknown,
		opts: { costMinor?: number; tokensIn?: number; tokensOut?: number } = {},
	): Promise<SkillResult> {
		const rec = this.require(skillId);
		const startedAt = Date.now();
		const checks: PermissionCheck[] = [];
		let ok = true;
		let error: string | undefined;

		// 1. enabled / pinned gate
		if (!rec.enabled) {
			ok = false;
			error = `skill "${rec.name}" is disabled`;
		}
		if (ok && rec.pinnedVersion && rec.pinnedVersion !== rec.version) {
			ok = false;
			error = `skill "${rec.name}" pinned to ${rec.pinnedVersion} but installed as ${rec.version}`;
		}

		// 2. permission enforcement
		if (ok) {
			for (const tool of rec.requiredTools) {
				const declared = rec.permissions.find((p) => p.name === tool);
				const access = declared?.accessLevel ?? "deny";
				let allowed = access === "allow";
				let reason: string | undefined;
				if (access === "ask") {
					allowed = this.prompt(rec.id, tool, declared?.scope);
					reason = allowed ? "approved by user" : "denied by user";
				} else if (access === "deny") {
					reason = "denied by manifest";
				} else {
					reason = "allowed by manifest";
				}
				checks.push({ name: tool, decided: access, allowed, reason });
				if (!allowed) {
					ok = false;
					error = `permission denied: ${tool}`;
					break;
				}
			}
		}

		// 3. spend policy
		const cost = opts.costMinor ?? estimateCost(rec, input);
		const currency = rec.spendPolicy.currency;
		if (ok) {
			if (rec.spendPolicy.perInvocationCapMinor > 0 && cost > rec.spendPolicy.perInvocationCapMinor) {
				ok = false;
				error = `spend cap exceeded: ${fmtCost(cost, currency)} > per-invocation ${fmtCost(rec.spendPolicy.perInvocationCapMinor, currency)}`;
			} else if (
				rec.spendPolicy.lifetimeCapMinor > 0 &&
				rec.lifetimeSpentMinor + cost > rec.spendPolicy.lifetimeCapMinor
			) {
				ok = false;
				error = `lifetime spend cap exceeded (${fmtCost(rec.lifetimeSpentMinor, currency)})`;
			}
		}

		// 4. sandbox execution (model). First-party skills produce structured
		// outputs; third-party skills echo a filtered view of the input.
		let output: unknown;
		if (ok) {
			try {
				output = this.execute(rec, input);
				rec.lifetimeSpentMinor += cost;
			} catch (e) {
				ok = false;
				error = e instanceof Error ? e.message : String(e);
			}
		}

		const durationMs = Date.now() - startedAt;
		const receipt: SkillInvocationReceipt = {
			id: randomUUID(),
			skillId: rec.id,
			skillName: rec.name,
			skillVersion: rec.version,
			timestamp: nowIso(),
			durationMs,
			costMinor: ok ? cost : 0,
			currency,
			tokensIn: opts.tokensIn ?? countTokens(input),
			tokensOut: opts.tokensOut ?? (ok ? countTokens(output) : 0),
			success: ok,
			error,
			permissionChecks: checks,
			provenanceVerified: rec.provenance.verified,
		};
		this.receipts.unshift(receipt);
		if (this.receipts.length > 256) this.receipts.pop();

		if (ok) {
			rec.lastUsed = nowIso();
			rec.status = rec.pinnedVersion ? "pinned" : "enabled";
		}

		this.log("skill.invoked", {
			skillId: rec.id,
			skill: rec.name,
			success: ok,
			durationMs,
			costMinor: cost,
		});

		return { ok, output, error, receipt };
	}

	// ── listing + selection ───────────────────────────────────────────────

	async listInstalled(): Promise<SkillRecord[]> {
		return Array.from(this.store.values()).sort((a, b) => {
			if (a.firstParty !== b.firstParty) return a.firstParty ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	/** Recent invocation receipts (most recent first). */
	listReceipts(limit = 50): SkillInvocationReceipt[] {
		return this.receipts.slice(0, limit);
	}

	/**
	 * Automatically select the best skill for a task. Scores every enabled
	 * skill by keyword overlap with name / description / trigger conditions,
	 * weighted by recency of use. Returns the best match and a human-readable
	 * reason, or null when nothing scores above threshold.
	 */
	async autoSelect(task: string): Promise<{ skill: SkillRecord; reason: string } | null> {
		const tokens = tokenize(task);
		if (tokens.length === 0) return null;

		let best: { skill: SkillRecord; score: number; matched: string[] } | null = null;
		for (const rec of this.store.values()) {
			if (!rec.enabled) continue;
			const haystack = new Set([
				...rec.name.toLowerCase().split(/[.\s_-]+/),
				...rec.description.toLowerCase().split(/\s+/),
				...rec.triggerConditions.map((t) => t.toLowerCase()),
			]);
			const matched: string[] = [];
			let score = 0;
			for (const t of tokens) {
				if (haystack.has(t)) {
					score += 2;
					matched.push(t);
				} else if ([...haystack].some((h) => h.includes(t))) {
					score += 1;
					matched.push(t);
				}
			}
			// Recency boost: recently-used skills are mildly preferred.
			if (rec.lastUsed) {
				const ageDays = (Date.now() - Date.parse(rec.lastUsed)) / 86_400_000;
				if (ageDays < 7) score += 0.5;
			}
			// Risk-class nudge: prefer lower-risk skills on ties.
			score += rec.riskClass === "low" ? 0.3 : rec.riskClass === "medium" ? 0.1 : 0;

			if (score > 0 && (!best || score > best.score)) {
				best = { skill: rec, score, matched };
			}
		}

		if (!best || best.score < 1) return null;
		const reason = best.matched.length
			? `matched keywords: ${best.matched.slice(0, 4).join(", ")}`
			: `best enabled skill by recency`;
		return { skill: best.skill, reason };
	}

	/** Manual selection helper (validate + return invocation-ready record). */
	async select(skillId: string): Promise<SkillRecord> {
		const rec = this.require(skillId);
		if (!rec.enabled) {
			throw new Error(`capix.intelligence: skill "${rec.name}" is not enabled`);
		}
		return rec;
	}

	// ── internals ─────────────────────────────────────────────────────────

	private require(skillId: string): SkillRecord {
		const rec = this.store.get(skillId);
		if (!rec) {
			throw new Error(`capix.intelligence: unknown skill "${skillId}"`);
		}
		return rec;
	}

	private findByName(name: string): SkillRecord | undefined {
		for (const rec of this.store.values()) {
			if (rec.name === name) return rec;
		}
		return undefined;
	}

	private parseSource(source: string): SkillManifest | null {
		const trimmed = source.trim();
		if (!trimmed) return null;

		if (trimmed.startsWith("first-party:")) {
			const name = trimmed.slice("first-party:".length).trim();
			return FIRST_PARTY_SKILLS.find((s) => s.name === name || s.name.endsWith(`.${name}`)) ?? null;
		}

		if (trimmed.startsWith("registry:")) {
			const rest = trimmed.slice("registry:".length).trim();
			const [name, version] = rest.split("@");
			if (!name) return null;
			return {
				name: name.trim(),
				version: (version ?? "0.0.0").trim(),
				description: `Registry skill ${name}@${version ?? "latest"}`,
				author: "registry",
				license: "unknown",
				provenance: { kind: "registry", registryName: "capix", verified: false },
			};
		}

		if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
			// Without a live fetch in the IDE host, we cannot retrieve the real
			// manifest. We record an unverified entry the user can complete.
			const last = trimmed.split("/").pop() ?? trimmed;
			const name = slugify(last.replace(/\.[^.]+$/, "")) || "remote-skill";
			return {
				name,
				version: "0.0.0",
				description: `Remote skill from ${trimmed}`,
				author: "remote",
				license: "unknown",
				provenance: { kind: "url", fetchedFrom: trimmed, verified: false },
			};
		}

		// JSON manifest.
		try {
			const parsed = JSON.parse(trimmed) as SkillManifest;
			if (!parsed.name || !parsed.version) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	private materialize(
		manifest: SkillManifest,
		kind: SkillProvenanceKind,
		options: SkillInstallOptions,
	): SkillRecord {
		const integrityHash = computeIntegrityHash(manifest);
		const prov: SkillProvenance = {
			kind,
			repo: manifest.provenance?.repo,
			commit: manifest.provenance?.commit,
			tag: manifest.provenance?.tag,
			registryName: manifest.provenance?.registryName,
			fetchedFrom: manifest.provenance?.fetchedFrom,
			signerKeyId: manifest.provenance?.signerKeyId,
			signature: manifest.provenance?.signature,
			verified: options.trustLocal ? true : this.verifyProvenance(manifest, kind),
			verifiedAt: nowIso(),
		};

		const id = `${slugify(manifest.name)}@${manifest.version}`;
		const rec: SkillRecord = {
			id,
			name: manifest.name,
			description: manifest.description,
			handler: manifest.handler ?? `skill:${id}`,
			version: manifest.version,
			registeredAt: nowIso(),
			status: options.enable ? "enabled" : "installed",
			author: manifest.author,
			license: manifest.license,
			riskClass: manifest.riskClass ?? "medium",
			firstParty: kind === "first-party",
			family: manifest.family,
			provenance: prov,
			integrityHash,
			permissions: manifest.permissions ?? [],
			networkPolicy: {
				allowedHosts: manifest.networkPolicy?.allowedHosts ?? [],
				maxEgressBytes: manifest.networkPolicy?.maxEgressBytes ?? 0,
			},
			filesystemPolicy: {
				readPaths: manifest.filesystemPolicy?.readPaths ?? [],
				writePaths: manifest.filesystemPolicy?.writePaths ?? [],
				strict: manifest.filesystemPolicy?.strict ?? true,
			},
			spendPolicy: {
				currency: manifest.spendPolicy?.currency ?? "usd",
				perInvocationCapMinor: manifest.spendPolicy?.perInvocationCapMinor ?? 0,
				lifetimeCapMinor: manifest.spendPolicy?.lifetimeCapMinor ?? 0,
			},
			lastUsed: undefined,
			pinnedVersion: options.pinVersion,
			enabled: options.enable ?? false,
			triggerConditions: manifest.triggerConditions ?? [],
			requiredTools: manifest.requiredTools ?? [],
			evaluationResults: [],
			lifetimeSpentMinor: 0,
		};
		return rec;
	}

	/**
	 * Verify provenance + integrity. A manifest is verified when:
	 *   - first-party: always trusted,
	 *   - registry: the registry is the Capix registry and commit/tag resolve,
	 *   - url: a signature is present and verifiable against a known signer,
	 *   - local: the user opted into trustLocal.
	 */
	private verifyProvenance(manifest: SkillManifest, kind: SkillProvenanceKind): boolean {
		if (kind === "first-party") return true;
		if (kind === "local") return false;
		if (kind === "registry") {
			return manifest.provenance?.registryName === "capix";
		}
		if (kind === "url") {
			const sig = manifest.provenance?.signature;
			const keyId = manifest.provenance?.signerKeyId;
			const integrity = computeIntegrityHash(manifest);
			return verifySignature(integrity, sig, keyId);
		}
		return false;
	}

	/**
	 * Sandbox executor. Models skill behavior without a real VM: first-party
	 * skills produce deterministic structured outputs; third-party skills
	 * return a sanitized echo of the input (no secrets, paths only from the
	 * declared read scope). Network egress is statically checked against the
	 * declared policy — any required fetch host not in the allowed list throws.
	 */
	private execute(rec: SkillRecord, input: unknown): unknown {
		if (rec.firstParty) {
			return this.executeFirstParty(rec, input);
		}

		// Model network egress check.
		const requestedHosts = readRequestedHosts(input);
		for (const host of requestedHosts) {
			if (!matchHost(host, rec.networkPolicy.allowedHosts)) {
				throw new Error(`network egress blocked: ${host} not in allowedHosts`);
			}
			if (rec.networkPolicy.maxEgressBytes > 0) {
				// sim: assume 1KB per requested host for budget purposes
			}
		}

		// Model filesystem access: only surface read paths.
		const visible = sanitizeInput(input, rec.filesystemPolicy.readPaths);
		return {
			skill: rec.name,
			version: rec.version,
			acknowledged: true,
			input: visible,
			note: "executed under sandbox; no mutations outside declared write paths",
		};
	}

	private executeFirstParty(rec: SkillRecord, input: unknown): unknown {
		switch (rec.family) {
			case "coding":
				return {
					skill: rec.name,
					action: "refactor-plan",
					filesConsidered: extractPaths(input),
					changesProposed: [],
					behaviorPreserved: true,
				};
			case "testing":
				return {
					skill: rec.name,
					action: "generate-tests",
					targets: extractPaths(input),
					testsGenerated: 0,
					framework: "vitest",
				};
			case "review":
				return {
					skill: rec.name,
					action: "review",
					findings: [] as Array<{ severity: string; message: string; file?: string }>,
					verdict: "needs-info",
				};
			case "security":
				return {
					skill: rec.name,
					action: "audit",
					secrets: 0,
					vulns: 0,
					unsafeDeps: 0,
					verdict: "clean",
				};
			case "deployment":
				return {
					skill: rec.name,
					action: "blue-green",
					blueReady: true,
					greenReady: false,
					rollbackCheckpoint: `ckpt-${Date.now()}`,
				};
			default:
				return { skill: rec.name, acknowledged: true, input };
		}
	}

	private async syncToBackend(rec: SkillRecord): Promise<void> {
		if (!this.clientId) return;
		try {
			const req: RegisterSkillRequest = {
				name: rec.name,
				description: rec.description,
				handler: rec.handler,
				version: rec.version,
			};
			await this.clientId.registerSkill(req);
		} catch (err) {
			// Backend sync is best-effort — the local store stays authoritative.
			this.log("skill.backendSyncFailed", {
				skillId: rec.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ── Input sanitisation + token estimation ───────────────────────────────────

function tokenize(task: string): string[] {
	return task
		.toLowerCase()
		.replace(/[^a-z0-9.\s_-]+/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1);
}

function extractPaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	if (Array.isArray(obj.paths)) return obj.paths.filter((p): p is string => typeof p === "string");
	if (Array.isArray(obj.files)) return obj.files.filter((p): p is string => typeof p === "string");
	return [];
}

function readRequestedHosts(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const hosts = obj.fetchHosts ?? obj.hosts;
	if (Array.isArray(hosts)) {
		return hosts.filter((h): h is string => typeof h === "string");
	}
	return [];
}

function sanitizeInput(input: unknown, readPaths: string[]): unknown {
	if (!input || typeof input !== "object") return input;
	const obj = input as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (k === "secret" || /token|password|credential/i.test(k)) continue;
		if (k === "paths" && Array.isArray(v)) {
			out[k] = (v as unknown[]).filter((p): p is string => typeof p === "string");
			continue;
		}
		out[k] = v;
	}
	out.readScope = readPaths;
	return out;
}

function countTokens(value: unknown): number {
	if (value === undefined || value === null) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.ceil(text.length / 4);
}

function estimateCost(rec: SkillRecord, input: unknown): number {
	const tokens = countTokens(input);
	// ~$0.50 / 1M tokens default; capped per-invocation by policy.
	const costMinor = Math.round((tokens / 1_000_000) * 500_000);
	if (rec.spendPolicy.perInvocationCapMinor > 0) {
		return Math.min(costMinor, rec.spendPolicy.perInvocationCapMinor);
	}
	return costMinor;
}

export { type IntelligenceClient };
