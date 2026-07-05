/**
 * Full-catalog express index build.
 *
 * Walks the ENTIRE Printful catalog (free API reads) and writes
 * data/express-catalog.json — the single product table shared by the express
 * planner, the truth source, and the app's product picker:
 *
 *   per product: name/brand/type, real base price (default variant), a
 *   suggested retail (pricing rule), techniques, aop flag, default variant,
 *   and per-placement print geometry (inches + dpi) with mockup style ids.
 *
 * Sources (shapes proven earlier in this project):
 *   - GET /products                       full catalog list (public)
 *   - GET /products/{id}                  variants + prices (public)
 *   - GET /v2/catalog-products/{id}/mockup-styles   placements, print areas,
 *     dpi, techniques, mockup style ids (auth)
 *
 * Usage: PRINTFUL_API_KEY=... npx tsx scripts/build-express-catalog.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_FILE = path.resolve("data/express-catalog.json");
const API = "https://api.printful.com";

const authHeaders = () => {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY is required");
  return { Authorization: `Bearer ${key}` };
};

const getJson = async (url: string, auth = false): Promise<unknown> => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, auth ? { headers: authHeaders() } : undefined);
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }
};

interface CatalogPlacement {
  placement: string;
  technique: string;
  widthIn: number;
  heightIn: number;
  dpi: number;
  styleIds: number[];
}

interface CatalogProduct {
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
  /** Required mockup product option names (truth-gated; e.g. stitch_color). */
  productOptions: string[];
  placements: CatalogPlacement[];
}

const num = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Suggested retail: industry-typical POD markup, psych-priced. */
const suggestRetail = (base: number): number => {
  const raw = Math.max(base * 1.85, base + 6);
  return Math.max(9.99, Math.ceil(raw) - 0.01);
};

const AOP_TECHNIQUES = new Set(["cut-sew", "sublimation"]);
const isLabel = (placement: string) => /label/i.test(placement);

const run = async () => {
  const list = (await getJson(`${API}/products`)) as {
    result: Array<{
      id: number;
      title: string;
      brand?: string | null;
      model?: string | null;
      type_name?: string;
      is_discontinued?: boolean;
    }>;
  };
  const products = list.result.filter((p) => !p.is_discontinued);
  console.log(`catalog products: ${products.length}`);
  await mkdir(path.dirname(OUT_FILE), { recursive: true });

  const out: Record<string, CatalogProduct> = {};
  let done = 0;
  let indexed = 0;

  for (const item of products) {
    try {
      const [detail, styles, v2product] = await Promise.all([
        getJson(`${API}/products/${item.id}`) as Promise<{
          result?: { variants?: Array<{ id: number; name: string; price: string }> };
        } | null>,
        getJson(`${API}/v2/catalog-products/${item.id}/mockup-styles?limit=100`, true) as Promise<{
          data?: Array<{
            placement?: string;
            technique?: string;
            print_area_width?: number;
            print_area_height?: number;
            dpi?: number;
            mockup_styles?: Array<{ id?: number }>;
          }>;
        } | null>,
        getJson(`${API}/v2/catalog-products/${item.id}`, true) as Promise<{
          data?: { product_options?: Array<{ name?: string }> };
        } | null>
      ]);

      const variants = detail?.result?.variants ?? [];
      const styleRows = styles?.data ?? [];
      if (!variants.length || !styleRows.length) {
        console.log(`${item.id} ${item.title}: skipped (variants=${variants.length}, placements=${styleRows.length})`);
        continue;
      }

      // mockup-styles repeats a placement once per style group — merge rows
      // by placement, unioning style ids and keeping the first geometry.
      const byPlacement = new Map<string, CatalogPlacement>();
      for (const row of styleRows) {
        if (typeof row.placement !== "string" || !row.placement) continue;
        const ids = (row.mockup_styles ?? [])
          .map((style) => style.id)
          .filter((id): id is number => typeof id === "number");
        const existing = byPlacement.get(row.placement);
        if (existing) {
          existing.styleIds = [...new Set([...existing.styleIds, ...ids])].slice(0, 8);
          continue;
        }
        byPlacement.set(row.placement, {
          placement: row.placement,
          technique: row.technique ?? "dtg",
          widthIn: num(row.print_area_width, 12),
          heightIn: num(row.print_area_height, 16),
          dpi: num(row.dpi, 150),
          styleIds: ids.slice(0, 8)
        });
      }
      const placements = [...byPlacement.values()];
      if (!placements.length) continue;

      // Default variant: prefer a white medium, then any medium, then middle
      // (variant names often end in "(White / M)" — match inclusively).
      const lower = variants.map((v) => v.name.toLowerCase());
      const preferred =
        variants[lower.findIndex((n) => n.includes("white / m"))] ??
        variants[lower.findIndex((n) => / \/ m\)?$/.test(n))] ??
        variants[Math.floor(variants.length / 2)];

      const prices = variants.map((v) => num(v.price, 0)).filter((p) => p > 0);
      const base = num(preferred.price, prices.length ? Math.min(...prices) : 0);
      if (!base) continue;

      const techniques = [...new Set(placements.map((p) => p.technique))];
      const renderable = placements.filter((p) => !isLabel(p.placement));
      const aop =
        renderable.length > 1 && renderable.every((p) => AOP_TECHNIQUES.has(p.technique));

      out[String(item.id)] = {
        id: item.id,
        name: item.title,
        brand: item.brand ?? null,
        model: item.model ?? null,
        type_name: item.type_name ?? "",
        baseCostUsd: base,
        retailUsd: suggestRetail(base),
        currency: "USD",
        aop,
        techniques,
        defaultVariantId: preferred.id,
        defaultVariantName: preferred.name,
        variantCount: variants.length,
        productOptions: (v2product?.data?.product_options ?? [])
          .map((option) => option.name)
          .filter((name): name is string => typeof name === "string"),
        placements
      };
      indexed++;
    } catch (error) {
      console.log(`${item.id} ${item.title}: ERROR ${(error as Error).message}`);
    }
    done++;
    if (done % 25 === 0) console.log(`... ${done}/${products.length} (${indexed} indexed)`);
    await new Promise((r) => setTimeout(r, 150));
  }

  await writeFile(
    OUT_FILE,
    JSON.stringify({ generated_at: new Date().toISOString(), products: out }, null, 1)
  );
  console.log(`\nWrote ${OUT_FILE}: ${indexed} products indexed of ${products.length}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
