/**
 * Index top-up for v2-only catalog products (absent from the v1 /products
 * list: Doormat, Yard Sign, licensed Columbia/Adidas items, Pet Hoodie...).
 * Variants + prices come from the v2 endpoints; placements/options from the
 * same v2 sources the main builder uses. Merges into
 * data/express-catalog.json in place.
 *
 * Usage: PRINTFUL_API_KEY=... npx tsx scripts/topup-express-catalog.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT_FILE = path.resolve("data/express-catalog.json");
const API = "https://api.printful.com";

const authHeaders = () => {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY is required");
  return { Authorization: `Bearer ${key}` };
};

const getJson = async (url: string): Promise<Record<string, unknown> | null> => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: authHeaders() });
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
};

const num = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const suggestRetail = (base: number): number =>
  Math.max(9.99, Math.ceil(Math.max(base * 1.15, base + 4)) - 0.01);

const AOP_TECHNIQUES = new Set(["cut-sew", "sublimation"]);
const isLabel = (placement: string) => /label/i.test(placement);

const run = async () => {
  const catalog = JSON.parse(readFileSync(OUT_FILE, "utf8")) as {
    generated_at: string;
    products: Record<string, unknown>;
  };
  const have = new Set(Object.keys(catalog.products).map(Number));

  // Full v2 id list -> the missing set.
  const v2: Array<{ id: number; name: string; brand?: string; model?: string; type?: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const body = (await getJson(`${API}/v2/catalog-products?limit=100&offset=${offset}`)) as {
      data?: Array<{ id: number; name: string; brand?: string; model?: string; type?: string }>;
    } | null;
    const items = body?.data ?? [];
    if (!items.length) break;
    v2.push(...items);
    if (items.length < 100) break;
  }
  const missing = v2.filter((p) => !have.has(p.id));
  console.log(`missing from index: ${missing.length}`);

  let added = 0;
  for (const item of missing) {
    try {
      const [variantsBody, pricesBody, stylesBody, productBody] = await Promise.all([
        getJson(`${API}/v2/catalog-products/${item.id}/catalog-variants?limit=100`),
        getJson(`${API}/v2/catalog-products/${item.id}/prices?currency=USD`),
        getJson(`${API}/v2/catalog-products/${item.id}/mockup-styles?limit=100`),
        getJson(`${API}/v2/catalog-products/${item.id}`)
      ]);
      const variants = ((variantsBody?.data ?? []) as Array<{
        id?: number;
        name?: string;
        size?: string;
        color?: string;
      }>).filter((v): v is { id: number; name: string; size?: string; color?: string } =>
        typeof v.id === "number"
      );
      const priceRows = ((pricesBody?.data as { variants?: Array<{ id?: number; techniques?: Array<{ price?: string }> }> })
        ?.variants ?? []);
      const priceById = new Map(
        priceRows.map((row) => [row.id, num(row.techniques?.[0]?.price, 0)])
      );
      const styleRows = (stylesBody?.data ?? []) as Array<{
        placement?: string;
        technique?: string;
        print_area_width?: number;
        print_area_height?: number;
        dpi?: number;
        mockup_styles?: Array<{ id?: number }>;
      }>;
      if (!variants.length || !styleRows.length) {
        console.log(`${item.id} ${item.name}: skipped (variants=${variants.length}, placements=${styleRows.length})`);
        continue;
      }
      const byPlacement = new Map<string, { placement: string; technique: string; widthIn: number; heightIn: number; dpi: number; styleIds: number[] }>();
      for (const row of styleRows) {
        if (typeof row.placement !== "string" || !row.placement) continue;
        const ids = (row.mockup_styles ?? []).map((s) => s.id).filter((id): id is number => typeof id === "number");
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

      const lower = variants.map((v) => v.name.toLowerCase());
      const preferred =
        variants[lower.findIndex((n) => n.includes("white / m"))] ??
        variants[lower.findIndex((n) => / \/ m\)?$/.test(n))] ??
        variants[Math.floor(variants.length / 2)];
      const base = priceById.get(preferred.id) || Math.min(...[...priceById.values()].filter((p) => p > 0));
      if (!base || !Number.isFinite(base)) {
        console.log(`${item.id} ${item.name}: skipped (no price)`);
        continue;
      }
      const techniques = [...new Set(placements.map((p) => p.technique))];
      const renderable = placements.filter((p) => !isLabel(p.placement));
      const aop = renderable.length > 1 && renderable.every((p) => AOP_TECHNIQUES.has(p.technique));

      catalog.products[String(item.id)] = {
        id: item.id,
        name: item.name,
        brand: item.brand ?? null,
        model: item.model ?? null,
        type_name: item.type ?? "",
        baseCostUsd: base,
        retailUsd: suggestRetail(base),
        currency: "USD",
        aop,
        techniques,
        defaultVariantId: preferred.id,
        defaultVariantName: preferred.name,
        variantCount: variants.length,
        productOptions: (((productBody?.data as { product_options?: Array<{ name?: string }> })
          ?.product_options) ?? [])
          .map((option) => option.name)
          .filter((name): name is string => typeof name === "string"),
        placements
      };
      added++;
      console.log(`${item.id} ${item.name}: added (${placements.length} placements, base $${base})`);
    } catch (error) {
      console.log(`${item.id} ${item.name}: ERROR ${(error as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  catalog.generated_at = new Date().toISOString();
  writeFileSync(OUT_FILE, JSON.stringify(catalog, null, 1));
  console.log(`\nMerged ${added} products; index now ${Object.keys(catalog.products).length}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
