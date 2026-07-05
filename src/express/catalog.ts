/**
 * Express-path product catalog: the ENTIRE Printful catalog, indexed offline.
 *
 * data/express-catalog.json (built by scripts/build-express-catalog.ts from
 * free Printful API reads) is the single product table shared by the express
 * planner, the runtime truth source, and the app's product picker endpoint —
 * per product: real base price, suggested retail, per-placement print
 * geometry (inches + dpi), mockup style ids, required product options, and
 * an AOP flag. Because backend planning and the frontend picker read the
 * same table, they cannot disagree.
 *
 * A small curated HERO table layers on top: for ambiguous customer words
 * ("hoodie" matches dozens of products) the proven best-sellers win; every
 * other product remains reachable by name/type keyword scoring or by an
 * explicit product_id from the app.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface CatalogPlacement {
  placement: string;
  technique: string;
  widthIn: number;
  heightIn: number;
  dpi: number;
  styleIds: number[];
}

export interface CatalogRecord {
  id: number;
  name: string;
  brand: string | null;
  model: string | null;
  type_name: string;
  baseCostUsd: number;
  retailUsd: number;
  currency: string;
  aop: boolean;
  techniques: string[];
  defaultVariantId: number;
  defaultVariantName: string;
  variantCount: number;
  productOptions: string[];
  placements: CatalogPlacement[];
}

/**
 * Merge duplicate placement rows (Printful's mockup-styles lists a placement
 * once per style group): union style ids, keep the first geometry. Applied
 * defensively at load AND by the live truth fallback.
 */
export const dedupePlacements = (placements: CatalogPlacement[]): CatalogPlacement[] => {
  const merged = new Map<string, CatalogPlacement>();
  for (const spec of placements) {
    const existing = merged.get(spec.placement);
    if (existing) {
      existing.styleIds = [...new Set([...existing.styleIds, ...spec.styleIds])];
      continue;
    }
    merged.set(spec.placement, { ...spec, styleIds: [...spec.styleIds] });
  }
  return [...merged.values()];
};

const loadFullCatalog = (): Record<string, CatalogRecord> => {
  const candidates = [
    path.resolve(process.cwd(), "data/express-catalog.json"),
    new URL("../../data/express-catalog.json", import.meta.url).pathname
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        products?: Record<string, CatalogRecord>;
      };
      if (parsed.products) {
        for (const record of Object.values(parsed.products)) {
          record.placements = dedupePlacements(record.placements);
        }
        return parsed.products;
      }
    } catch {
      // try next candidate
    }
  }
  return {};
};

const FULL_CATALOG = loadFullCatalog();

export const catalogSize = (): number => Object.keys(FULL_CATALOG).length;

export const getCatalogRecord = (
  productId: number | string | null | undefined
): CatalogRecord | undefined => {
  const id = typeof productId === "string" ? Number(productId) : productId;
  if (!id || !Number.isFinite(id)) return undefined;
  return FULL_CATALOG[String(id)];
};

export interface ExpressProduct {
  productId: number;
  name: string;
  /** Lowercase keywords scored against the customer text (heroes only). */
  keywords: string[];
  /** Multi-panel all-over product: full coverage is included in base cost. */
  aop: boolean;
  /** Substring used to pick a sensible variant by name (live fallback only). */
  variantPick?: string;
  baseCostUsd: number;
  retailUsd: number;
}

/**
 * Curated best-sellers: deterministic winners for the most common customer
 * words. Prices/aop are refreshed from the full catalog record when present,
 * so these carry only routing preference, not stale numbers.
 */
const HERO_CATALOG: ExpressProduct[] = [
  {
    productId: 71,
    name: "Unisex Staple T-Shirt (Bella+Canvas 3001)",
    keywords: ["t-shirt", "tshirt", "tee", "shirt"],
    aop: false,
    variantPick: "White / M",
    baseCostUsd: 9.25,
    retailUsd: 24.99
  },
  {
    productId: 257,
    name: "All-Over Print Men's Crew Neck T-Shirt",
    keywords: ["all-over tee", "aop tee", "all over shirt", "aop shirt", "all-over print shirt"],
    aop: true,
    variantPick: "M",
    baseCostUsd: 17.5,
    retailUsd: 36.99
  },
  {
    productId: 388,
    name: "All-Over Print Recycled Unisex Hoodie",
    keywords: ["hoodie", "hooded", "sweatshirt"],
    aop: true,
    variantPick: "M",
    baseCostUsd: 41.5,
    retailUsd: 69.99
  },
  {
    productId: 242,
    name: "All-Over Print Yoga Leggings",
    keywords: ["leggings", "yoga pants", "tights"],
    aop: true,
    variantPick: "M",
    baseCostUsd: 26.5,
    retailUsd: 54.99
  },
  {
    productId: 657,
    name: "AOP Lace-Up Canvas Shoes",
    keywords: ["shoes", "sneakers", "kicks", "canvas shoes"],
    aop: true,
    baseCostUsd: 49.0,
    retailUsd: 89.99
  },
  {
    productId: 390,
    name: "All-Over Print Bomber Jacket",
    keywords: ["bomber", "jacket"],
    aop: true,
    variantPick: "M",
    baseCostUsd: 52.0,
    retailUsd: 99.99
  },
  {
    productId: 279,
    name: "All-Over Print Backpack",
    keywords: ["backpack", "bag", "rucksack"],
    aop: true,
    baseCostUsd: 34.0,
    retailUsd: 64.99
  },
  {
    productId: 19,
    name: "White Glossy Mug",
    keywords: ["mug", "cup", "coffee mug"],
    aop: false,
    variantPick: "11",
    baseCostUsd: 4.95,
    retailUsd: 15.99
  }
];

/** Kept for callers/tests that iterate the curated set. */
export const EXPRESS_CATALOG = HERO_CATALOG;

/** Cheapest-to-fulfill safe default when nothing matches. */
export const DEFAULT_PRODUCT_ID = 71;

const productFromRecord = (record: CatalogRecord): ExpressProduct => ({
  productId: record.id,
  name: record.name,
  keywords: [],
  aop: record.aop,
  baseCostUsd: record.baseCostUsd,
  retailUsd: record.retailUsd
});

/** Hero preferences + full-catalog truth (real prices/aop win over anchors). */
const withRecordTruth = (hero: ExpressProduct): ExpressProduct => {
  const record = getCatalogRecord(hero.productId);
  if (!record) return hero;
  return {
    ...hero,
    name: record.name,
    aop: record.aop,
    baseCostUsd: record.baseCostUsd,
    retailUsd: record.retailUsd
  };
};

export const getExpressProduct = (productId: number): ExpressProduct | undefined => {
  const hero = HERO_CATALOG.find((product) => product.productId === productId);
  if (hero) return withRecordTruth(hero);
  const record = getCatalogRecord(productId);
  return record ? productFromRecord(record) : undefined;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "make", "made", "want", "like",
  "design", "print", "printed", "custom", "cool", "please", "front", "back",
  "all", "over", "one", "art", "artwork", "put", "get", "very", "some"
]);

const tokenize = (text: string): string[] => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  )
];

const scoreRecord = (record: CatalogRecord, tokens: string[]): number => {
  const name = record.name.toLowerCase();
  const type = record.type_name.toLowerCase();
  const extra = `${record.brand ?? ""} ${record.model ?? ""}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += token.length * 2;
    if (type.includes(token)) score += token.length * 3;
    if (extra.includes(token)) score += token.length;
  }
  return score;
};

/**
 * Deterministic product match, cheapest first:
 *   1. curated hero keyword hit (longest keyword wins)
 *   2. full-catalog token scoring over name/type/brand
 *   3. safe default (71)
 */
export const matchExpressProduct = (text: string): ExpressProduct => {
  const haystack = ` ${text.toLowerCase()} `;
  let hero: { product: ExpressProduct; score: number } | null = null;
  for (const product of HERO_CATALOG) {
    for (const keyword of product.keywords) {
      if (!haystack.includes(keyword)) continue;
      if (!hero || keyword.length > hero.score) hero = { product, score: keyword.length };
    }
  }
  if (hero) return withRecordTruth(hero.product);

  const tokens = tokenize(text);
  if (tokens.length) {
    let best: { record: CatalogRecord; score: number } | null = null;
    for (const record of Object.values(FULL_CATALOG)) {
      const score = scoreRecord(record, tokens);
      if (score > 0 && (!best || score > best.score || (score === best.score && record.id < best.record.id))) {
        best = { record, score };
      }
    }
    if (best) return productFromRecord(best.record);
  }
  return getExpressProduct(DEFAULT_PRODUCT_ID) ?? productFromRecord(Object.values(FULL_CATALOG)[0]);
};

export interface CatalogSearchRow {
  id: number;
  name: string;
  type_name: string;
  baseCostUsd: number;
  retailUsd: number;
  aop: boolean;
  variantCount: number;
  placementCount: number;
  techniques: string[];
}

const toSearchRow = (record: CatalogRecord): CatalogSearchRow => ({
  id: record.id,
  name: record.name,
  type_name: record.type_name,
  baseCostUsd: record.baseCostUsd,
  retailUsd: record.retailUsd,
  aop: record.aop,
  variantCount: record.variantCount,
  placementCount: record.placements.filter((p) => !/label/i.test(p.placement)).length,
  techniques: record.techniques
});

/** Product picker feed: same table the planner uses. */
export const searchCatalog = (query: string, limit = 50): CatalogSearchRow[] => {
  const records = Object.values(FULL_CATALOG);
  const tokens = tokenize(query);
  if (!tokens.length) {
    // Default browse order: curated heroes first, then the rest by id.
    const heroIds = new Set(HERO_CATALOG.map((product) => product.productId));
    const heroes = records.filter((record) => heroIds.has(record.id));
    const rest = records.filter((record) => !heroIds.has(record.id)).sort((a, b) => a.id - b.id);
    return [...heroes, ...rest].slice(0, limit).map(toSearchRow);
  }
  return records
    .map((record) => ({ record, score: scoreRecord(record, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id - b.record.id)
    .slice(0, limit)
    .map((entry) => toSearchRow(entry.record));
};
