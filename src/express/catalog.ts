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

/**
 * Retail pricing is the OWNER'S lever, not baked data: computed at runtime
 * from the real Printful base cost using env-configurable markup.
 *
 *   THREADBOT_MARKUP_PCT   percent over base (default 15)
 *   THREADBOT_MARKUP_FLAT  flat dollars added (default 3)
 *
 * The $4-over-base floor keeps every sale above payment fees (2.9% + $0.30)
 * plus amortized AI cost (~$0.05/run) even at zero markup settings. Change
 * the env vars on the Cloud Run service to reprice the whole catalog
 * instantly — no rebuild, no data regeneration.
 */
export const computeRetail = (base: number): number => {
  const pct = Number(process.env.THREADBOT_MARKUP_PCT ?? 15);
  const flat = Number(process.env.THREADBOT_MARKUP_FLAT ?? 3);
  const raw = Math.max(
    base * (1 + (Number.isFinite(pct) ? pct : 15) / 100) + (Number.isFinite(flat) ? flat : 3),
    base + 4
  );
  return Math.max(4.99, Math.ceil(raw) - 0.01);
};

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
  retailUsd: computeRetail(record.baseCostUsd)
});

/** Hero preferences + full-catalog truth (real prices/aop win over anchors). */
const withRecordTruth = (hero: ExpressProduct): ExpressProduct => {
  const record = getCatalogRecord(hero.productId);
  if (!record) return { ...hero, retailUsd: computeRetail(hero.baseCostUsd) };
  return {
    ...hero,
    name: record.name,
    aop: record.aop,
    baseCostUsd: record.baseCostUsd,
    retailUsd: computeRetail(record.baseCostUsd)
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
  "all", "over", "one", "art", "artwork", "put", "get", "very", "some", "new",
  "unisex"
]);

/**
 * Lay-language synonym expansion: customers know neither the supplier nor
 * its vocabulary. Deterministic and free — expands query tokens into the
 * words catalog names actually use. Multi-word keys match as phrases.
 */
const SYNONYMS: Record<string, string[]> = {
  onesie: ["bodysuit", "one", "piece", "baby"],
  romper: ["bodysuit", "baby"],
  tee: ["t-shirt"],
  tshirt: ["t-shirt"],
  shirt: ["t-shirt", "shirt"],
  hoody: ["hoodie"],
  hoodies: ["hoodie"],
  jumper: ["sweatshirt", "sweater"],
  sweater: ["sweatshirt", "sweater", "knitted"],
  crewneck: ["crew", "neck", "sweatshirt"],
  joggers: ["sweatpants", "joggers"],
  "sweat pants": ["sweatpants"],
  cap: ["cap", "hat"],
  hat: ["hat", "cap"],
  snapback: ["snapback"],
  beanie: ["beanie"],
  sneakers: ["shoes", "canvas"],
  sneaker: ["shoes", "canvas"],
  kicks: ["shoes"],
  trainers: ["shoes"],
  sandals: ["slides", "flip", "flops"],
  crocs: ["slides"],
  poster: ["poster"],
  "wall art": ["poster", "canvas"],
  painting: ["canvas"],
  "canvas print": ["canvas"],
  purse: ["crossbody", "bag"],
  "fanny pack": ["fanny", "pack"],
  "bum bag": ["fanny", "pack"],
  "laptop case": ["laptop", "sleeve"],
  "phone case": ["case", "iphone", "samsung"],
  iphone: ["iphone", "case"],
  samsung: ["samsung", "case"],
  galaxy: ["samsung", "case"],
  airpods: ["airpods", "case"],
  cup: ["mug"],
  "coffee mug": ["mug"],
  "water bottle": ["water", "bottle"],
  thermos: ["tumbler", "bottle", "insulated"],
  blanket: ["blanket", "throw"],
  throw: ["throw", "blanket"],
  towel: ["towel"],
  swimsuit: ["swimsuit", "one-piece", "bikini"],
  "bathing suit": ["swimsuit", "bikini", "swim"],
  "swim trunks": ["swim", "trunks"],
  boardshorts: ["board", "shorts"],
  "board shorts": ["board", "shorts"],
  trunks: ["swim", "trunks", "shorts"],
  leggins: ["leggings"],
  "yoga pants": ["leggings", "yoga"],
  tights: ["leggings"],
  dress: ["dress"],
  skirt: ["skirt"],
  "tank top": ["tank", "top"],
  singlet: ["tank", "top"],
  "long sleeve": ["long", "sleeve"],
  longsleeve: ["long", "sleeve"],
  socks: ["socks"],
  apron: ["apron"],
  candle: ["candle"],
  puzzle: ["jigsaw", "puzzle"],
  rug: ["rug", "area"],
  carpet: ["rug"],
  doormat: ["doormat"],
  "door mat": ["doormat"],
  "mouse pad": ["mouse", "pad"],
  mousepad: ["mouse", "pad"],
  stickers: ["sticker"],
  decal: ["decals", "sticker"],
  magnet: ["magnets"],
  journal: ["journal", "notebook"],
  diary: ["journal", "notebook"],
  ornament: ["ornament"],
  "pet leash": ["pet", "leash"],
  "dog leash": ["pet", "leash"],
  "dog collar": ["pet", "collar"],
  "cat collar": ["pet", "collar"],
  "dog bowl": ["pet", "bowl"],
  windbreaker: ["windbreaker"],
  "track jacket": ["track", "jacket"],
  "zip up": ["zip", "hoodie"],
  vest: ["vest"],
  polo: ["polo"],
  jersey: ["jersey"],
  "sports bra": ["sports", "bra"],
  scrunchie: ["scrunchie"],
  bandana: ["bandana"],
  "neck gaiter": ["neck", "gaiter"],
  gaiter: ["neck", "gaiter"],
  "flip flops": ["flip", "flops"],
  "flip-flops": ["flip", "flops"],
  "shower curtain": ["shower", "curtain"],
  tapestry: ["tapestry"],
  coaster: ["coaster"],
  "pint glass": ["pint", "glass"],
  "wine glass": ["wine", "glass"],
  "shot glass": ["rocks", "glass"],
  "playing cards": ["poker", "playing", "cards"],
  "greeting card": ["greeting", "card"],
  postcard: ["postcard"],
  calendar: ["calendar"],
  "yoga mat": ["yoga", "mat"],
  "gym bag": ["gym", "bag"],
  "duffle bag": ["duffle", "bag"],
  duffel: ["duffle"],
  suitcase: ["suitcase"],
  luggage: ["suitcase"],
  "teddy bear": ["teddy", "bear"],
  "license plate": ["license", "plate"],
  pillowcase: ["pillow", "case"],
  cushion: ["pillow"],
  "crop top": ["crop", "top"],
  croptop: ["crop", "top"],
  anorak: ["anorak", "windbreaker"],
  cardigan: ["cardigan"],
  "letterman jacket": ["letterman", "jacket"],
  "bomber jacket": ["bomber", "jacket"],
  "trucker hat": ["trucker"],
  "dad hat": ["dad", "hat"],
  "bucket hat": ["bucket", "hat"],
  visor: ["visor"],
  headband: ["headband"],
  "baby tee": ["baby", "tee", "rib"],
  toddler: ["toddler"],
  youth: ["youth", "kids"],
  kids: ["kids", "youth"],
  kid: ["kids", "youth"],
  baby: ["baby"],
  infant: ["baby"],
  oversized: ["oversized"],
  "high tops": ["high", "top", "shoes"],
  "slip on": ["slip-on", "shoes"],
  "slip-ons": ["slip-on", "shoes"]
};

const tokenize = (text: string): string[] => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  )
];

/** Tokens + phrase-aware synonym expansion (word-boundary matched — "that"
 *  must never trigger the "hat" synonym). Derived tokens are tracked so the
 *  scorer can weight the customer's own words above expansions. */
export const expandQueryDetailed = (
  text: string
): { tokens: string[]; derived: Set<string> } => {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
  const explicit = new Set(tokenize(text));
  const derived = new Set<string>();
  for (const [phrase, additions] of Object.entries(SYNONYMS)) {
    if (lower.includes(` ${phrase} `)) {
      for (const term of additions) if (!explicit.has(term)) derived.add(term);
    }
  }
  return { tokens: [...explicit, ...derived], derived };
};

export const expandQuery = (text: string): string[] => expandQueryDetailed(text).tokens;

/** Damerau-lite: edit distance <= 1 for typo'd tokens ("hoddie" ~ "hoodie"). */
const nearMatch = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1 || a[0] !== b[0]) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) {
      // allow one adjacent transposition
      return a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2) === b;
    }
    return true;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) {
    if (short === long.slice(0, i) + long.slice(i + 1)) return true;
  }
  return false;
};

export interface IndexedRecord {
  record: CatalogRecord;
  tokens: string[];
  haystack: string;
}

let RECORD_INDEX: IndexedRecord[] | null = null;
let TOKEN_DF: Map<string, number> | null = null;

export const recordIndex = (): IndexedRecord[] => {
  if (!RECORD_INDEX) {
    RECORD_INDEX = Object.values(FULL_CATALOG).map((record) => {
      const haystack = `${record.name} ${record.type_name} ${record.brand ?? ""} ${record.model ?? ""}`
        .toLowerCase()
        .replace(/[®™|]/g, " ");
      return { record, tokens: tokenize(haystack), haystack };
    });
    TOKEN_DF = new Map();
    for (const entry of RECORD_INDEX) {
      for (const token of new Set(entry.tokens)) {
        TOKEN_DF.set(token, (TOKEN_DF.get(token) ?? 0) + 1);
      }
    }
  }
  return RECORD_INDEX;
};

/**
 * Threadbot prompts are mostly ARTWORK words with one product noun buried
 * inside ("a poster of a mountain sunrise"). Weight hits by catalog
 * document-frequency: tokens shared by >=3 products are product-type
 * vocabulary (poster, hoodie, case); singletons are incidental model naming
 * ("Mountain Lodge") that artwork words collide with — nearly mute them.
 * Synonym-derived tokens count less than words the customer actually typed.
 */
export const scoreIndexed = (
  entry: IndexedRecord,
  queryTokens: string[],
  derived: Set<string> = new Set()
): number => {
  recordIndex(); // ensure DF table exists
  const hits: Array<{ base: number; qt: string }> = [];
  for (const qt of queryTokens) {
    let base = 0;
    if (entry.tokens.includes(qt)) base = 3 + qt.length;
    else if (entry.tokens.some((rt) => nearMatch(qt, rt))) base = 2 + Math.floor(qt.length / 2);
    if (base) hits.push({ base, qt });
  }
  if (!hits.length) return 0;
  let score = 0;
  let matchedWeight = 0;
  for (const { base, qt } of hits) {
    // Singleton muting exists to stop artwork words hitting incidental
    // model names ("Mountain Lodge"). A record matching >=2 query words is
    // a corroborated product match — unique product nouns ("bowl", "flag")
    // then count at full strength.
    let weight = (TOKEN_DF!.get(qt) ?? 1) >= 2 || hits.length >= 2 ? 1 : 0.35;
    if (derived.has(qt)) weight *= 0.6;
    score += base * weight;
    matchedWeight += Math.min(1, weight);
  }
  // Coverage: favor records explaining MORE of the query (so "oversized
  // hoodie" beats plain "hoodie" products), and shorter names on ties.
  score += (matchedWeight / queryTokens.length) * 12;
  score -= Math.min(4, Math.floor(entry.tokens.length / 8));
  return Math.round(score * 10) / 10;
};

/**
 * Customers never say "AOP" — when intent detects all-over language, ambiguous
 * words upgrade to the all-over sibling of the matched hero.
 */
const AOP_UPGRADES: Record<number, number> = {
  71: 257 // Bella tee -> AOP crew tee
};

/**
 * Deterministic full-catalog product match. EVERY indexed product is
 * reachable from lay language: query tokens are synonym-expanded (customers
 * don't know supplier vocabulary), matched exactly or typo-tolerantly
 * against every product's name/type/brand, coverage-weighted (so "oversized
 * hoodie" beats plain hoodies), AOP-boosted when the design demands full
 * coverage, with curated best-sellers acting only as TIEBREAK bonuses for
 * generic words — never as shortcuts that hide the rest of the catalog.
 */
export const matchExpressProduct = (
  text: string,
  options?: { preferAop?: boolean }
): ExpressProduct => {
  const preferAop = options?.preferAop === true;
  const { tokens: queryTokens, derived } = expandQueryDetailed(text);
  const haystack = ` ${text.toLowerCase()} `;
  let best: { record: CatalogRecord; score: number } | null = null;
  let bestAop: { record: CatalogRecord; score: number } | null = null;
  if (queryTokens.length) {
    const phrase = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim()} `;
    for (const entry of recordIndex()) {
      let score = scoreIndexed(entry, queryTokens, derived);
      if (!score) continue;
      // Exact-phrase presence in the product name is the strongest signal.
      if (phrase.trim().length >= 6 && ` ${entry.haystack} `.includes(phrase)) score += 6;
      // Curated best-sellers get a small TIEBREAK nudge for generic words —
      // never enough to beat a product that matches more of the query.
      const hero = HERO_CATALOG.find((product) => product.productId === entry.record.id);
      if (hero && hero.keywords.some((keyword) => haystack.includes(keyword))) score += 3;
      if (!best || score > best.score || (score === best.score && entry.record.id < best.record.id)) {
        best = { record: entry.record, score };
      }
      if (
        entry.record.aop &&
        (!bestAop || score > bestAop.score || (score === bestAop.score && entry.record.id < bestAop.record.id))
      ) {
        bestAop = { record: entry.record, score };
      }
    }
  }
  // All-over designs demand an all-over product: take the best AOP candidate
  // whenever one plausibly matches the request at all.
  if (preferAop && bestAop && (!best || !best.record.aop)) {
    if (!best || bestAop.score >= best.score * 0.5) best = bestAop;
    else if (AOP_UPGRADES[best.record.id]) {
      return getExpressProduct(AOP_UPGRADES[best.record.id]) ?? productFromRecord(best.record);
    }
  }
  if (best) return productFromRecord(best.record);
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
  retailUsd: computeRetail(record.baseCostUsd),
  aop: record.aop,
  variantCount: record.variantCount,
  placementCount: record.placements.filter((p) => !/label/i.test(p.placement)).length,
  techniques: record.techniques
});

/** Product picker feed: same table + same scorer the planner uses. */
export const searchCatalog = (query: string, limit = 50): CatalogSearchRow[] => {
  const records = Object.values(FULL_CATALOG);
  const { tokens: queryTokens, derived } = expandQueryDetailed(query);
  if (!queryTokens.length) {
    // Default browse order: curated heroes first, then the rest by id.
    const heroIds = new Set(HERO_CATALOG.map((product) => product.productId));
    const heroes = records.filter((record) => heroIds.has(record.id));
    const rest = records.filter((record) => !heroIds.has(record.id)).sort((a, b) => a.id - b.id);
    return [...heroes, ...rest].slice(0, limit).map(toSearchRow);
  }
  return recordIndex()
    .map((entry) => ({ record: entry.record, score: scoreIndexed(entry, queryTokens, derived) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id - b.record.id)
    .slice(0, limit)
    .map((entry) => toSearchRow(entry.record));
};
