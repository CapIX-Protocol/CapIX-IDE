/**
 * Standalone local Merkle verifier — no network, no I/O, no npm workspace deps.
 *
 * This is a self-contained port of the SHA-256 + domain-separation + sibling
 * path walk from @capix/merkle (packages/merkle/src/index.ts). It uses only
 * Node.js `crypto.createHash('sha256')` so it can run in the extension host
 * without pulling in the monorepo workspace package.
 *
 * Security:
 *  - NEVER fetches anything from the network.
 *  - NEVER logs leaf fields, secrets, or customer data.
 *  - Returns false for any malformed input (never throws for bad proofs).
 *  - Throws only for programmer errors (e.g. wrong-length root hex).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FieldJSON, ProofPackage } from "./apiClient";

// ── Domain separation tags (§2.2) ────────────────────────────────────────

const LEAF_DOMAIN = Buffer.from("capix:merkle:leaf:v1", "utf8");
const NODE_DOMAIN = Buffer.from("capix:merkle:node:v1", "utf8");

// ── Field kind discriminators (§3.4) ─────────────────────────────────────

const FIELD_KIND = {
  HASH: 0x01,
  U64: 0x02,
  STRING: 0x03,
  BYTES: 0x04,
  NULL: 0x05,
  U8: 0x06,
  BOOL: 0x07,
} as const;

// ── Primitive writers ────────────────────────────────────────────────────

/** SHA-256 of a byte sequence → 32 bytes. */
function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Concatenate Buffers. */
function concat(...parts: Uint8Array[]): Buffer {
  const bufs = parts.map((p) => Buffer.from(p));
  return Buffer.concat(bufs);
}

/** u32 little-endian → 4 bytes. */
function writeU32LE(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`writeU32LE: value out of range (${value})`);
  }
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(value, 0);
  return b;
}

/** u64 little-endian → 8 bytes (BigInt, two's complement, no sign bit). */
function writeU64LE(value: bigint): Buffer {
  if (typeof value !== "bigint") throw new TypeError("writeU64LE: expected bigint");
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError(`writeU64LE: value out of u64 range (${value})`);
  }
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(value, 0);
  return b;
}

/** Strings: UTF-8 bytes length-prefixed with u32 LE. */
function writeString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return concat(writeU32LE(body.length), body);
}

/** Variable bytes: u32 LE length + bytes. */
function writeBytes(value: Buffer): Buffer {
  return concat(writeU32LE(value.length), value);
}

/** Encode a single JSON field as field_kind:u8 ‖ value. */
function encodeField(field: FieldJSON): Buffer {
  switch (field.kind) {
    case "hash": {
      const buf = Buffer.from(field.value, "hex");
      if (buf.length !== 32) throw new RangeError(`encodeField: hash must be 32 bytes (got ${buf.length})`);
      return concat(Buffer.from([FIELD_KIND.HASH]), buf);
    }
    case "u64":
      return concat(Buffer.from([FIELD_KIND.U64]), writeU64LE(BigInt(field.value)));
    case "string":
      return concat(Buffer.from([FIELD_KIND.STRING]), writeString(field.value));
    case "bytes":
      return concat(Buffer.from([FIELD_KIND.BYTES]), writeBytes(Buffer.from(field.value, "hex")));
    case "null":
      return Buffer.from([FIELD_KIND.NULL]);
    case "u8":
      return concat(Buffer.from([FIELD_KIND.U8]), Buffer.from([field.value]));
    case "bool":
      return concat(Buffer.from([FIELD_KIND.BOOL]), Buffer.from([field.value ? 1 : 0]));
    default: {
      const _exhaustive: never = field;
      throw new Error(`encodeField: unknown field kind ${(field as FieldJSON).kind ?? _exhaustive}`);
    }
  }
}

/** Encode an ordered field list as the concatenation of encodeField for each. */
function encodeFields(fields: readonly FieldJSON[]): Buffer {
  const parts: Buffer[] = new Array(fields.length);
  for (let i = 0; i < fields.length; i++) parts[i] = encodeField(fields[i]);
  return concat(...parts);
}

/**
 * Compute a leaf hash (§4):
 * leaf_hash = H( LEAF_DOMAIN ‖ u32_le(leafVersion) ‖ enc(leaf) )
 */
function hashLeafBody(leafVersion: number, fullFields: readonly FieldJSON[]): Buffer {
  return sha256(concat(LEAF_DOMAIN, writeU32LE(leafVersion), encodeFields(fullFields)));
}

/** hex string → 32-byte Buffer (throws on bad hex / wrong length). */
function fromHex32(hex: string): Buffer {
  if (typeof hex !== "string" || hex.length !== 64) {
    throw new RangeError(`fromHex32: expected 64-char hex string (got length ${hex?.length ?? "?"})`);
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new RangeError(`fromHex32: expected 32 bytes (got ${buf.length})`);
  return buf;
}

/** Constant-time equality of two equal-length Buffers. */
function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Public verification API ───────────────────────────────────────────────

export interface VerifyResult {
  /** true iff the recomputed root matches the proof's claimed root. */
  valid: boolean;
  /** The recomputed Merkle root as lowercase hex (64 chars). */
  computedRoot: string;
  /** The root claimed in the proof package. */
  expectedRoot: string;
  /** Human-readable failure reason (empty when valid). */
  error: string;
}

/**
 * Verify a proof package locally — no network, no I/O, no side effects.
 *
 * Recomputes the leaf hash from the leaf fields, walks the sibling path,
 * and compares the computed root against the proof's claimed root.
 *
 * Implements spec §6.1 (verification algorithm) and §6.2 (category binding).
 *
 * @param pkg  The proof package from the API (ProofPackage).
 * @param expectedCategory  Optional category override. Defaults to pkg.leafCategory.
 * @returns VerifyResult with `valid`, `computedRoot`, `expectedRoot`, and `error`.
 */
export function verifyProofLocally(
  pkg: ProofPackage,
  expectedCategory?: string,
): VerifyResult {
  const expectedRoot = pkg.root;
  const category = expectedCategory ?? pkg.leafCategory;

  try {
    if (pkg.leafVersion !== 1) {
      return { valid: false, computedRoot: "", expectedRoot, error: `leaf version ${pkg.leafVersion} is not supported (expected 1)` };
    }

    // Parse the claimed root from hex
    const root = fromHex32(expectedRoot);

    // §6.2: assert proof.leafCategory == expected category
    if (pkg.leafCategory !== category) {
      return { valid: false, computedRoot: "", expectedRoot, error: `leaf category "${pkg.leafCategory}" does not match expected "${category}"` };
    }

    // §6.1 step 1: recompute leaf_hash
    let h = hashLeafBody(pkg.leafVersion, pkg.leaf);

    const leafIndex = BigInt(pkg.leafIndex);
    const leafCount = BigInt(pkg.leafCount);

    // §6.1 step 4: single-leaf tree → root == H(NODE_DOMAIN ‖ leaf ‖ leaf)
    if (leafCount === 1n) {
      if (pkg.path.length !== 0) {
        return { valid: false, computedRoot: "", expectedRoot, error: "single-leaf tree must have an empty path" };
      }
      const nodeHash = sha256(concat(NODE_DOMAIN, h, h));
      const computedHex = nodeHash.toString("hex");
      const valid = constantTimeEqual(nodeHash, root);
      return { valid, computedRoot: computedHex, expectedRoot, error: valid ? "" : "computed root does not match claimed root" };
    }

    // §6.1 steps 5–6: walk the path
    let idx = leafIndex;
    for (const step of pkg.path) {
      const sibling = fromHex32(step.sibling);
      if (step.siblingIsRight) {
        // this node is the LEFT child → idx must be even
        if (idx % 2n !== 0n) {
          return { valid: false, computedRoot: "", expectedRoot, error: "sibling position mismatch (expected even index for left child)" };
        }
        h = sha256(concat(NODE_DOMAIN, h, sibling));
      } else {
        // this node is the RIGHT child → idx must be odd
        if (idx % 2n !== 1n) {
          return { valid: false, computedRoot: "", expectedRoot, error: "sibling position mismatch (expected odd index for right child)" };
        }
        h = sha256(concat(NODE_DOMAIN, sibling, h));
      }
      idx = idx / 2n;
    }

    // §6.1 step 7: assert h == root
    const computedHex = h.toString("hex");
    const valid = constantTimeEqual(h, root);
    return { valid, computedRoot: computedHex, expectedRoot, error: valid ? "" : "computed root does not match claimed root" };
  } catch (err) {
    return {
      valid: false,
      computedRoot: "",
      expectedRoot,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
