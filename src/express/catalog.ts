/**
 * Express-path hero catalog.
 *
 * The agent pipeline discovers products dynamically through the
 * product-intelligence MCP; the express path instead ships a small curated
 * table of proven, high-margin SKUs and matches the customer's words against
 * it deterministically. Rationale (unit economics):
 *
 *   - Matching costs zero LLM tokens; the mobile app can also pass an
 *     explicit product_id and skip matching entirely (a picker converts
 *     better than a guess).
 *   - Every entry here has been rendered through the real Printful mockup
 *     generator during this project (calibration grids, live demos), so the
 *     express path only sells what it can provably produce.
 *
 * baseCostUsd / retailUsd are pricing ANCHORS (approximate Printful base +
 * suggested retail) used for margin telemetry, not provider truth — the
 * agent pipeline's Pricing Basis node remains the source of verified pricing.
 */

export interface ExpressProduct {
  productId: number;
  name: string;
  /** Lowercase keywords scored against the customer text. */
  keywords: string[];
  /** Multi-panel all-over product: full coverage is included in base cost. */
  aop: boolean;
  /** Substring used to pick a sensible default variant by name. */
  variantPick?: string;
  baseCostUsd: number;
  retailUsd: number;
}

export const EXPRESS_CATALOG: ExpressProduct[] = [
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

/** Cheapest-to-fulfill safe default when nothing matches. */
export const DEFAULT_PRODUCT_ID = 71;

export const getExpressProduct = (productId: number): ExpressProduct | undefined =>
  EXPRESS_CATALOG.find((product) => product.productId === productId);

/**
 * Deterministic keyword match: longest-keyword hit wins (so "all-over tee"
 * beats "tee"), ties broken by catalog order. Zero tokens spent.
 */
export const matchExpressProduct = (text: string): ExpressProduct => {
  const haystack = ` ${text.toLowerCase()} `;
  let best: { product: ExpressProduct; score: number } | null = null;
  for (const product of EXPRESS_CATALOG) {
    for (const keyword of product.keywords) {
      if (!haystack.includes(keyword)) continue;
      const score = keyword.length;
      if (!best || score > best.score) best = { product, score };
    }
  }
  return best?.product ?? getExpressProduct(DEFAULT_PRODUCT_ID)!;
};
