/**
 * Express-path product truth: placement geometry, mockup style ids, variants
 * and required product options, fetched directly from Printful's public
 * catalog API and cached in-process.
 *
 * Cost model: these calls are free (catalog reads), and the cache means a
 * warm instance pays them once per product — every subsequent run for that
 * product is pure arithmetic. All fetching happens BEFORE any paid image
 * generation, so a truth failure aborts a run at $0 spent.
 *
 * Endpoint shapes are the ones proven live during this project:
 *   - GET /v2/catalog-products/{id}/mockup-styles     print areas (inches),
 *     dpi, techniques, mockup style ids (same payload the hosted mockups MCP
 *     returns from list_printful_mockup_styles)
 *   - GET /products/{id}  (v1)                        variants (public)
 *   - GET /v2/catalog-products/{id}                   product_options truth
 *     (the stitch_color requirement gate used in the MCP patch)
 */

import { dedupePlacements, getCatalogRecord } from "./catalog.js";

const PRINTFUL_API_BASE = process.env.PRINTFUL_API_BASE ?? "https://api.printful.com";

export interface PlacementSpec {
  placement: string;
  technique: string;
  widthIn: number;
  heightIn: number;
  dpi: number;
  styleIds: number[];
}

export interface ProductTruth {
  placementSpecs(productId: number): Promise<PlacementSpec[]>;
  resolveVariant(productId: number, pick?: string): Promise<number>;
  productOptionNames(productId: number): Promise<string[]>;
}

const authHeaders = () => {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY is not set (express product truth)");
  return { Authorization: `Bearer ${key}` };
};

const num = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getJson = async (url: string, headers?: Record<string, string>): Promise<unknown> => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, headers ? { headers } : undefined);
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
      continue;
    }
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

class Cached<T> {
  private store = new Map<number, { at: number; value: T }>();
  async get(key: number, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await load();
    this.store.set(key, { at: Date.now(), value });
    return value;
  }
}

export class PrintfulTruth implements ProductTruth {
  private specs = new Cached<PlacementSpec[]>();
  private variants = new Cached<Array<{ id: number; name: string }>>();
  private options = new Cached<string[]>();

  async placementSpecs(productId: number): Promise<PlacementSpec[]> {
    // Static-first: the committed full-catalog index answers with zero
    // network; live Printful reads are the fallback for products indexed
    // after the last build.
    const record = getCatalogRecord(productId);
    if (record?.placements.length) return record.placements;
    return this.specs.get(productId, async () => {
      const body = (await getJson(
        `${PRINTFUL_API_BASE}/v2/catalog-products/${productId}/mockup-styles?limit=100`,
        authHeaders()
      )) as {
        data?: Array<{
          placement?: string;
          technique?: string;
          print_area_width?: number;
          print_area_height?: number;
          dpi?: number;
          mockup_styles?: Array<{ id?: number }>;
        }>;
      };
      const specs = (body.data ?? [])
        .filter((entry) => typeof entry.placement === "string" && entry.placement)
        .map((entry) => ({
          placement: entry.placement as string,
          technique: entry.technique ?? "dtg",
          widthIn: num(entry.print_area_width, 12),
          heightIn: num(entry.print_area_height, 16),
          dpi: num(entry.dpi, 150),
          styleIds: (entry.mockup_styles ?? [])
            .map((style) => style.id)
            .filter((id): id is number => typeof id === "number")
        }));
      if (!specs.length) {
        throw new Error(`Printful lists no mockup placements for product ${productId}`);
      }
      // mockup-styles repeats a placement once per style group.
      return dedupePlacements(specs);
    });
  }

  async resolveVariant(productId: number, pick?: string): Promise<number> {
    // With no customer preference, the committed index is authoritative
    // (zero network; its default was chosen with a white/medium preference).
    // A stated color/size preference is worth one free cached catalog read.
    const record = getCatalogRecord(productId);
    if (record?.defaultVariantId && !pick) return record.defaultVariantId;
    try {
      return await this.matchVariant(productId, pick);
    } catch (error) {
      if (record?.defaultVariantId) return record.defaultVariantId;
      throw error;
    }
  }

  private async matchVariant(productId: number, pick?: string): Promise<number> {
    const variants = await this.variants.get(productId, async () => {
      const body = (await getJson(`${PRINTFUL_API_BASE}/products/${productId}`)) as {
        result?: { variants?: Array<{ id?: number; name?: string }> };
      };
      const list = (body.result?.variants ?? [])
        .filter((v): v is { id: number; name: string } => typeof v.id === "number")
        .map((v) => ({ id: v.id, name: v.name ?? "" }));
      if (!list.length) throw new Error(`Printful lists no variants for product ${productId}`);
      return list;
    });
    if (pick) {
      // Token match, case-insensitive: "black xl" -> "... (Black / XL)".
      // All tokens first, then the most tokens, then exact substring.
      const tokens = pick.toLowerCase().split(/\s+/).filter(Boolean);
      let best: { id: number; hits: number } | null = null;
      for (const variant of variants) {
        const name = variant.name.toLowerCase();
        const hits = tokens.filter((token) => name.includes(token)).length;
        if (hits > 0 && (!best || hits > best.hits)) best = { id: variant.id, hits };
      }
      if (best) return best.id;
      const exact = variants.find((variant) => variant.name.includes(pick));
      if (exact) return exact.id;
    }
    return variants[0].id;
  }

  async productOptionNames(productId: number): Promise<string[]> {
    const record = getCatalogRecord(productId);
    if (record) return record.productOptions;
    return this.options.get(productId, async () => {
      const body = (await getJson(
        `${PRINTFUL_API_BASE}/v2/catalog-products/${productId}`,
        authHeaders()
      )) as { data?: { product_options?: Array<{ name?: string }> } };
      return (body.data?.product_options ?? [])
        .map((option) => option.name)
        .filter((name): name is string => typeof name === "string");
    });
  }
}
