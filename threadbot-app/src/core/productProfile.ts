/**
 * Threadbot product profiles.
 *
 * Every product variant Threadbot has touched gets its OWN profile: the real,
 * Printful-fetched panel structure (front/back/sleeves/hood/pocket/...) plus the
 * technique. We fetch it ONCE per (product, variant, technique) and keep it in
 * memory so we never re-pay for a retrieval we've already made. The profile is the
 * source of truth for "how many panels MUST this product produce" — so a hoodie that
 * needs 6 panels never silently passes with 1.
 *
 * The cache is mutable on purpose: profiles can be refreshed/refined over time as we
 * learn more about a product, so issues don't stay baked in.
 */

import type { Panel } from "./surface.js";

export interface ProductProfile {
  key: string;
  providerProductId: number | string;
  providerVariantId: number | string;
  technique: string;
  /** Every printable panel Printful exposes for this variant. */
  panels: Panel[];
  updatedAt: string;
  /** Free-form learnings we can grow over time (per-panel notes, fixes, etc.). */
  notes?: Record<string, unknown>;
}

type PanelFetcher = (
  productId: number | string,
  technique: string,
  variantId: number | string
) => Promise<Panel[]>;

const cache = new Map<string, ProductProfile>();

export function profileKey(
  productId: number | string,
  variantId: number | string,
  technique: string
): string {
  return `${productId}::${variantId}::${technique}`;
}

/**
 * Return the profile for a variant, fetching + caching it on first encounter.
 * Subsequent calls for the same (product, variant, technique) are served from memory.
 */
export async function getOrBuildProfile(
  fetchPanels: PanelFetcher,
  productId: number | string,
  variantId: number | string,
  technique: string
): Promise<ProductProfile> {
  const key = profileKey(productId, variantId, technique);
  const hit = cache.get(key);
  if (hit && hit.panels.length) return hit;

  const panels = await fetchPanels(productId, technique, variantId);
  const profile: ProductProfile = {
    key,
    providerProductId: productId,
    providerVariantId: variantId,
    technique,
    panels,
    updatedAt: new Date().toISOString(),
  };
  cache.set(key, profile);
  return profile;
}

/** Merge new learnings into a cached profile (kept for future refinement passes). */
export function refineProfile(key: string, notes: Record<string, unknown>): void {
  const p = cache.get(key);
  if (p) p.notes = { ...(p.notes ?? {}), ...notes };
}

export function profileCacheSize(): number {
  return cache.size;
}
