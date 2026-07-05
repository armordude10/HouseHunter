/**
 * Printful adapter — implements FulfillmentProvider against the Printful V1 API,
 * using the exact routes from the supplied Postman collection ("Printful API External").
 *
 * Everything Printful-shaped is contained in this file. Swapping suppliers = adding a
 * sibling adapter; the core never changes.
 *
 *   geometry   GET  /mockup-generator/templates/{product_id}?technique=
 *   variants   GET  /products/{product_id}
 *   estimate   POST /orders/estimate-costs
 *   draft      POST /orders
 *   confirm    POST /orders/{id}/confirm
 */

import type {
  CostEstimate,
  FulfillmentProvider,
  FileOption,
  NeutralOrder,
  PlacementGeometry,
  PrintPosition,
  ResolvedVariant,
  Technique,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BASE = "https://api.printful.com";

interface PrintfulTemplate {
  template_id: number;
  image_url: string;
  background_url: string | null;
  background_color: string | null;
  printfile_id: number;
  template_width: number;
  template_height: number;
  print_area_width: number;
  print_area_height: number;
  print_area_top: number;
  print_area_left: number;
  orientation: string;
}

interface PrintfulVariantMapping {
  variant_id: number;
  templates: Array<{ placement: string; template_id: number }>;
}

export class PrintfulProvider implements FulfillmentProvider {
  readonly name = "printful";

  constructor(
    private readonly apiKey: string,
    private readonly storeId: string
  ) {}

  private async request<T = any>(
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "X-PF-Store-ID": this.storeId,
          "Content-Type": "application/json",
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text();
      // Leaky-bucket rate limit: back off and retry rather than failing the request.
      if (res.status === 429 && attempt < 4) {
        const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
        await sleep((Number.isFinite(ra) ? ra : 5 * (attempt + 1)) * 1000);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Printful ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
      }
      const json = text ? JSON.parse(text) : {};
      return (json.result ?? json) as T;
    }
  }

  async resolveVariant(
    providerProductId: number | string,
    color: string,
    size?: string
  ): Promise<ResolvedVariant> {
    const result = await this.request<{ variants: Array<{ id: number; color: string; size: string }> }>(
      `/products/${providerProductId}`
    );
    const variants = result.variants ?? [];
    const wantColor = color.trim().toLowerCase();
    const byColor = variants.filter((v) => v.color?.toLowerCase() === wantColor);
    const pool = byColor.length ? byColor : variants;

    let match = pool[0];
    if (size) {
      const wantSize = size.trim().toLowerCase();
      match = pool.find((v) => v.size?.toLowerCase() === wantSize) ?? match;
    }
    if (!match) {
      throw new Error(`No Printful variant for product ${providerProductId} color "${color}"`);
    }
    return {
      providerProductId,
      providerVariantId: match.id,
      color: match.color,
      size: match.size,
    };
  }

  async getPlacementGeometry(
    providerProductId: number | string,
    providerVariantId: number | string,
    placement: string,
    technique: Technique
  ): Promise<PlacementGeometry> {
    const q = technique ? `?technique=${encodeURIComponent(String(technique))}` : "";
    const result = await this.request<{
      templates: PrintfulTemplate[];
      variant_mapping: PrintfulVariantMapping[];
    }>(`/mockup-generator/templates/${providerProductId}${q}`);

    const mapping = (result.variant_mapping ?? []).find(
      (m) => String(m.variant_id) === String(providerVariantId)
    );
    const templateRef =
      mapping?.templates.find((t) => t.placement === placement) ?? mapping?.templates[0];
    const tpl =
      (templateRef && result.templates.find((t) => t.template_id === templateRef.template_id)) ??
      result.templates[0];

    if (!tpl) {
      throw new Error(
        `No Printful template for product ${providerProductId} variant ${providerVariantId} placement ${placement}`
      );
    }

    return {
      placement,
      technique,
      baseImageUrl: tpl.image_url,
      backgroundColor: tpl.background_color ?? undefined,
      templateWidth: tpl.template_width,
      templateHeight: tpl.template_height,
      printAreaWidth: tpl.print_area_width,
      printAreaHeight: tpl.print_area_height,
      printAreaTop: tpl.print_area_top,
      printAreaLeft: tpl.print_area_left,
      printfileId: tpl.printfile_id,
    };
  }

  async resolveDecorationOptions(
    _placement: string,
    technique: Technique,
    _fileUrl: string
  ): Promise<FileOption[]> {
    // DTG/AOP need no decoration options. For embroidery let Printful auto-pick
    // thread colors from the artwork (POST /files/thread-colors is the explicit
    // alternative if you want to surface the palette to the user).
    if (technique === "embroidery") {
      return [{ id: "auto_thread_color", value: true }];
    }
    return [];
  }

  async estimateCost(order: NeutralOrder): Promise<CostEstimate> {
    const costs = await this.request<{ costs: any }>("/orders/estimate-costs", {
      method: "POST",
      body: toPrintfulOrder(order),
    }).then((r: any) => r.costs ?? r);

    return {
      subtotal: num(costs.subtotal),
      shipping: num(costs.shipping),
      tax: num(costs.tax) + num(costs.vat),
      total: num(costs.total),
      currency: costs.currency ?? "USD",
    };
  }

  async createDraftOrder(order: NeutralOrder): Promise<string> {
    // No ?confirm=1 -> stays a draft until confirmOrder().
    const result = await this.request<{ id: number }>("/orders", {
      method: "POST",
      body: toPrintfulOrder(order),
    });
    return String(result.id);
  }

  async confirmOrder(providerOrderId: string): Promise<void> {
    await this.request(`/orders/${providerOrderId}/confirm`, { method: "POST" });
  }

  async cancelOrder(providerOrderId: string): Promise<void> {
    await this.request(`/orders/${providerOrderId}`, { method: "DELETE" });
  }

  /** Default print technique + a representative color for any catalog product. */
  async getProductTruth(
    productId: number | string
  ): Promise<{ technique: string; defaultColor: string; placements: string[] }> {
    const result = await this.request<{
      product: { techniques?: Array<{ key: string; is_default: boolean }> };
      variants: Array<{ color: string }>;
    }>(`/products/${productId}`);
    const techs = result.product?.techniques ?? [];
    const technique = (techs.find((t) => t.is_default)?.key ?? techs[0]?.key ?? "dtg").toLowerCase();
    const colors = [...new Set((result.variants ?? []).map((v) => v.color))];
    const defaultColor = colors.includes("Black") ? "Black" : colors.includes("White") ? "White" : colors[0] ?? "";
    const placements = await this.getPlacements(productId, technique).catch(() => []);
    return { technique, defaultColor, placements };
  }

  /** Valid placements for a product (authoritative for mockups + orders). */
  async getPlacements(productId: number | string, technique?: string): Promise<string[]> {
    const q = technique ? `?technique=${encodeURIComponent(technique)}` : "";
    const r = await this.request<{ available_placements?: Record<string, string> }>(
      `/mockup-generator/printfiles/${productId}${q}`
    );
    return Object.keys(r.available_placements ?? {});
  }

  /** Panels (placements) of a product with their printfile dimensions, labels included. */
  async getPanels(
    productId: number | string,
    technique: string,
    variantId?: number | string
  ): Promise<Array<{ placement: string; width: number; height: number; dpi: number }>> {
    const q = technique ? `?technique=${encodeURIComponent(technique)}` : "";
    const r = await this.request<any>(`/mockup-generator/printfiles/${productId}${q}`);
    const byId: Record<number, any> = Object.fromEntries(
      (r.printfiles ?? []).map((f: any) => [f.printfile_id, f])
    );
    const vmap =
      (r.variant_printfiles ?? []).find((x: any) => String(x.variant_id) === String(variantId)) ??
      r.variant_printfiles?.[0];
    const panels: Array<{ placement: string; width: number; height: number; dpi: number }> = [];
    for (const [placement, pfid] of Object.entries(vmap?.placements ?? {})) {
      const f = byId[pfid as number];
      if (f) panels.push({ placement, width: f.width, height: f.height, dpi: f.dpi ?? 150 });
    }
    return panels;
  }

  /** Resolve a catalog product id by a name/model substring (e.g. "gildan 5000"). */
  async findCatalogProduct(query: string): Promise<{ id: number; name: string } | null> {
    const rx = new RegExp(query.trim().replace(/\s+/g, "\\s*") + "\\b", "i");
    const all = await this.request<Array<{ id: number; title: string; is_discontinued?: boolean }>>("/products");
    const match = (all ?? []).find((p) => !p.is_discontinued && rx.test(p.title || ""));
    return match ? { id: match.id, name: match.title } : null;
  }

  /** Available garment colours (name + hex) from the v2 catalog product. */
  async getColors(productId: number | string): Promise<Array<{ name: string; hex: string }>> {
    const r = await this.request<{ data?: { colors?: Array<{ name: string; value: string }> } }>(
      `/v2/catalog-products/${productId}`
    );
    return (r?.data?.colors ?? [])
      .map((c) => ({ name: c.name, hex: c.value }))
      .filter((c) => c.name && c.hex);
  }

  /** v2 print-area (pixels) per placement, used to shape each panel's art so it fills. */
  async getPrintAreasV2(
    productId: number | string,
    placements: string[]
  ): Promise<Map<string, { width: number; height: number }>> {
    const map = new Map<string, { width: number; height: number }>();
    try {
      const names = [...new Set(placements)].join(",");
      const tpl = await this.request<{
        data: Array<{ placement: string; print_area_width: number; print_area_height: number }>;
      }>(`/v2/catalog-products/${Number(productId)}/mockup-templates?placements=${encodeURIComponent(names)}`);
      for (const t of tpl.data ?? [])
        if (!map.has(t.placement)) map.set(t.placement, { width: t.print_area_width, height: t.print_area_height });
    } catch (e) {
      console.error("[printful] getPrintAreasV2 failed:", (e as Error).message);
    }
    return map;
  }

  /** A REAL Printful mockup across one or more panels (v2 mockup-tasks; async + poll). */
  async renderMockup(args: {
    productId: number | string;
    variantId: number | string;
    technique?: string;
    files: Array<{ placement: string; fileUrl: string; position: PrintPosition; dpi?: number }>;
  }): Promise<string> {
    const views = await this.renderMockupViews(args);
    if (!views.length) throw new Error("mockup task returned no mockup url");
    return views[0];
  }

  /**
   * v2 Mockup Generator. Each panel is a `placement` carrying a `layers` array, and
   * each layer is a positioned file in the print-area pixel space (the same `position`
   * the order endpoint consumes). That lets one product render every panel in a single
   * task, and lets a panel stack multiple layers (art + text/number) when needed.
   */
  async renderMockupViews(args: {
    productId: number | string;
    variantId: number | string;
    technique?: string;
    files: Array<{ placement: string; fileUrl: string; position: PrintPosition; dpi?: number }>;
  }): Promise<string[]> {
    const tech = (args.technique || "dtg").toLowerCase();
    const cutSew = /cut|sew|aop|sublim|all.?over/.test(tech);
    const placements = args.files.map((f) => {
      // v2 layer position is INCHES; PrintPosition is print-area px at this dpi. The art is
      // pre-shaped to the panel's print area in the core, so position aspect matches the file.
      const dpi = f.dpi && f.dpi > 0 ? f.dpi : 150;
      const toIn = (px: number) => Math.round((px / dpi) * 100) / 100;
      return {
        placement: f.placement,
        technique: tech,
        print_area_type: "simple",
        layers: [
          {
            type: "file",
            url: f.fileUrl,
            position: {
              top: toIn(f.position.top),
              left: toIn(f.position.left),
              width: toIn(f.position.width),
              height: toIn(f.position.height),
            },
          },
        ],
      };
    });

    // Cut-sew products require a product-level seam stitch_color we can't always infer
    // from the technique string — so try our best guess, then self-heal if it's missing.
    const buildBody = (stitch: boolean) => {
      const product: Record<string, unknown> = {
        source: "catalog",
        catalog_product_id: Number(args.productId),
        catalog_variant_ids: [Number(args.variantId)],
        placements,
      };
      if (stitch) product.product_options = [{ name: "stitch_color", value: "white" }];
      return { products: [product] };
    };
    let created: { data: Array<{ id: number; status: string }> };
    try {
      created = await this.request("/v2/mockup-tasks", { method: "POST", body: buildBody(cutSew) });
    } catch (e) {
      if (!cutSew && String((e as Error).message).includes("stitch_color")) {
        created = await this.request("/v2/mockup-tasks", { method: "POST", body: buildBody(true) });
      } else throw e;
    }
    const taskId = created.data?.[0]?.id;
    if (taskId == null) throw new Error(`mockup task not created: ${JSON.stringify(created).slice(0, 220)}`);

    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const got = await this.request<{
        data: Array<{
          id: number;
          status: string;
          catalog_variant_mockups?: Array<{
            catalog_variant_id?: number;
            mockups?: Array<{ placement: string; mockup_url?: string }>;
          }>;
        }>;
      }>(`/v2/mockup-tasks?id=${encodeURIComponent(String(taskId))}`);
      const task = got.data?.[0];
      if (!task) continue;
      if (task.status === "failed") throw new Error(`mockup task failed: ${JSON.stringify(task).slice(0, 220)}`);
      const cvs = task.catalog_variant_mockups ?? [];
      // Return the mockups for the CHOSEN variant (the colour we picked); fall back to all.
      const chosen = cvs.find((cv) => String(cv.catalog_variant_id) === String(args.variantId));
      const urls: string[] = [];
      for (const cv of chosen ? [chosen] : cvs)
        for (const m of cv.mockups ?? []) if (m.mockup_url) urls.push(m.mockup_url);
      if (urls.length) return urls;
    }
    throw new Error("mockup task timed out");
  }

  async checkAvailability(
    providerVariantId: number | string
  ): Promise<{ inStock: boolean; discontinued: boolean }> {
    // Best-effort: confirm the variant resolves. Real stock is best maintained from
    // the `stock_updated` webhook into a cache rather than polled per order.
    try {
      await this.request(`/products/variant/${providerVariantId}`);
      return { inStock: true, discontinued: false };
    } catch {
      return { inStock: false, discontinued: true };
    }
  }
}

/** NeutralOrder -> Printful V1 order body (shape from the Postman collection). */
function toPrintfulOrder(order: NeutralOrder): Record<string, unknown> {
  return {
    external_id: order.externalId,
    shipping: "STANDARD",
    recipient: order.recipient,
    items: order.items.map((it) => ({
      variant_id: it.providerVariantId,
      quantity: it.quantity,
      files: it.files.map((f) => ({
        type: f.type,
        url: f.url,
        position: f.position,
        ...(f.options.length ? { options: f.options } : {}),
      })),
      ...(it.options.length ? { options: it.options } : {}),
    })),
    ...(order.retailCosts ? { retail_costs: order.retailCosts } : {}),
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}
