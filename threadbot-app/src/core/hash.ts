/**
 * Exact-match fingerprinting.
 *
 * The whole "the customer is never sold something different from the preview"
 * guarantee reduces to this: hash the size-independent design at preview time,
 * lock it on the DesignSpec, and at fulfillment recompute it from the spec we are
 * about to submit and refuse to confirm if it differs.
 *
 * Pure. Imports only node:crypto + types. No zod, no sharp, no network.
 */

import { createHash } from "node:crypto";
import type {
  DesignFingerprint,
  FileOption,
  Placement,
  PrintPosition,
  ProviderBinding,
} from "../providers/types.js";

/** Stable JSON: object keys sorted recursively so key order can't change the hash. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep(obj[k]);
        return acc;
      }, {});
  }
  return v;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Input shape for the fingerprint — just the design-relevant slice of a spec. */
export interface FingerprintInput {
  provider: string;
  providerBinding: Pick<ProviderBinding, "providerProductId">;
  color: string;
  placements: Placement[];
}

/**
 * Build the canonical, size-independent fingerprint.
 * Arrays are pre-sorted (placements by name, options by id) because canonicalize
 * only sorts object keys, not array order.
 */
export function buildFingerprint(spec: FingerprintInput): DesignFingerprint {
  return {
    provider: spec.provider,
    providerProductId: spec.providerBinding.providerProductId,
    color: spec.color,
    placements: [...spec.placements]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        name: p.name,
        technique: p.technique,
        fileUrl: p.fileUrl,
        fileSha256: p.fileSha256,
        position: normalizePosition(p.position),
        options: sortOptions(p.options),
      })),
  };
}

function normalizePosition(p: PrintPosition): PrintPosition {
  // Explicit field copy so an unexpected extra key can't drift the hash.
  return {
    area_width: p.area_width,
    area_height: p.area_height,
    width: p.width,
    height: p.height,
    top: p.top,
    left: p.left,
  };
}

function sortOptions(options: FileOption[]): FileOption[] {
  return [...options]
    .map((o) => ({ id: o.id, value: o.value }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function computeOrderHash(spec: FingerprintInput): string {
  return sha256Hex(canonicalize(buildFingerprint(spec)));
}
