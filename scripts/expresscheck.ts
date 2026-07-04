/**
 * Offline express-path check (no API keys, $0.00 spent).
 *
 * Proves the unit-economics contract of the express run with stubs:
 *
 *   - a refused request costs exactly zero paid calls
 *   - a full AOP hoodie run costs 1 structured LLM call + 1 image generation
 *     and still covers every renderable placement (labels excluded)
 *   - non-AOP products plan the primary placement only (margin rule)
 *   - explicit product_id overrides keyword matching
 *   - an LLM outage degrades to the heuristic intent instead of killing the run
 *   - a mockup-service failure preserves the generated panels (retryable)
 *   - stitch color and product matching are deterministic
 *
 * Run: npm run expresscheck
 */

import sharp from "sharp";
import { MediaLike } from "../src/engine/panelCompiler.js";
import { LlmProvider, StructuredParams } from "../src/llm/provider.js";
import { ChatCompletionParams, ChatCompletionResult } from "../src/runware/client.js";
import { matchExpressProduct } from "../src/express/catalog.js";
import { ExpressIntent, heuristicIntent, screenRequest } from "../src/express/intent.js";
import { pickStitchColor } from "../src/express/plan.js";
import { runExpress, ExpressDeps } from "../src/express/run.js";
import { PlacementSpec, ProductTruth } from "../src/express/truth.js";
import { createAndWaitForMockups } from "../src/integrations/printfulMockups.js";

// -----------------------------------------------------------------------------
// Stubs.
// -----------------------------------------------------------------------------

const gradientPng = async (width: number, height: number): Promise<Buffer> => {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round((x / Math.max(1, width - 1)) * 255);
      raw[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      raw[i + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
};

const toDataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString("base64")}`;

class StubMedia implements MediaLike {
  uploads = new Map<string, Buffer>();
  generateCalls = 0;

  async generateImage(params: { positivePrompt: string; width: number; height: number }) {
    this.generateCalls++;
    return { imageURL: toDataUrl(await gradientPng(params.width, params.height)) };
  }
  async removeBackground(imageUrl: string) {
    return { imageURL: imageUrl };
  }
  async upscale(image: string, factor: 2 | 3 | 4) {
    const buffer = this.uploads.get(image) ?? Buffer.from(image.split(",")[1] ?? "", "base64");
    const meta = await sharp(buffer).metadata();
    const out = await sharp(buffer)
      .resize((meta.width ?? 1) * factor, (meta.height ?? 1) * factor, { fit: "fill" })
      .png()
      .toBuffer();
    return { imageURL: toDataUrl(out) };
  }
  async uploadImage(image: string) {
    const uuid = `upload-${this.uploads.size}`;
    this.uploads.set(uuid, Buffer.from(image.split(",")[1] ?? "", "base64"));
    return uuid;
  }
}

class StubProvider implements LlmProvider {
  readonly name = "runware" as const;
  structuredCalls = 0;
  captionCalls = 0;
  intent: ExpressIntent | null = null;
  failStructured = false;

  resolveModel(model: string): string {
    return model;
  }
  async chat(_params: ChatCompletionParams): Promise<ChatCompletionResult> {
    throw new Error("express path must not use the chat tool loop");
  }
  async structured(_params: StructuredParams): Promise<string> {
    this.structuredCalls++;
    if (this.failStructured) throw new Error("stubbed LLM outage");
    if (!this.intent) throw new Error("no canned intent configured");
    return JSON.stringify(this.intent);
  }
  async captionImage(_url: string): Promise<string> {
    this.captionCalls++;
    return "a hand-drawn koi fish sketch";
  }
}

// Small stub canvases (low dpi) keep raster work fast; the geometry MATH is
// identical to production because everything downstream is resolution-free
// fractions and inches.
const HOODIE_SPECS: PlacementSpec[] = [
  "front",
  "back",
  "sleeve_left",
  "sleeve_right",
  "hood",
  "pocket"
].map((placement) => ({
  placement,
  technique: "cut-sew",
  widthIn: 40,
  heightIn: 40,
  dpi: 24,
  styleIds: placement === "front" ? [11, 12, 13] : [11]
}));
HOODIE_SPECS.push({
  placement: "label_inside",
  technique: "cut-sew",
  widthIn: 3,
  heightIn: 3,
  dpi: 24,
  styleIds: []
});

const TEE_SPECS: PlacementSpec[] = [
  { placement: "front", technique: "dtg", widthIn: 12, heightIn: 16, dpi: 40, styleIds: [21, 22] },
  { placement: "back", technique: "dtg", widthIn: 12, heightIn: 16, dpi: 40, styleIds: [21] },
  { placement: "label_outside", technique: "dtg", widthIn: 3, heightIn: 3, dpi: 40, styleIds: [] }
];

const MUG_SPECS: PlacementSpec[] = [
  { placement: "default", technique: "sublimation", widthIn: 9, heightIn: 3.5, dpi: 40, styleIds: [31] }
];

class StubTruth implements ProductTruth {
  async placementSpecs(productId: number): Promise<PlacementSpec[]> {
    if (productId === 388) return HOODIE_SPECS;
    if (productId === 71) return TEE_SPECS;
    if (productId === 19) return MUG_SPECS;
    throw new Error(`stub truth has no product ${productId}`);
  }
  async resolveVariant(productId: number): Promise<number> {
    return productId * 1000 + 1;
  }
  async productOptionNames(productId: number): Promise<string[]> {
    return productId === 388 ? ["stitch_color", "lifelike"] : [];
  }
}

type MockupParams = Parameters<typeof createAndWaitForMockups>[0];

const makeMockupStub = (outcome: "completed" | "failed") => {
  const calls: MockupParams[] = [];
  const render: typeof createAndWaitForMockups = async (params) => {
    calls.push(params);
    if (outcome === "failed") return { status: "failed", mockups: [], raw: null };
    return {
      status: "completed",
      mockups: params.styleIds.map((styleId) => ({
        view: "front",
        style_id: styleId,
        mockup_url: `https://printful-mockups.example/${params.productId}/${styleId}.jpg`,
        placement: params.placements[0]?.placement ?? "front"
      })),
      raw: null
    };
  };
  return { calls, render };
};

const makeDeps = (
  intent: ExpressIntent | null,
  options: { failLLM?: boolean; mockupOutcome?: "completed" | "failed" } = {}
) => {
  const provider = new StubProvider();
  provider.intent = intent;
  provider.failStructured = options.failLLM ?? false;
  const media = new StubMedia();
  const mockups = makeMockupStub(options.mockupOutcome ?? "completed");
  const deps: ExpressDeps = {
    provider,
    media,
    truth: new StubTruth(),
    renderMockups: mockups.render
  };
  return { deps, provider, media, mockups };
};

const intentFor = (overrides: Partial<ExpressIntent>): ExpressIntent => ({
  ...heuristicIntent(""),
  allowed: true,
  artwork_brief: "A luminous koi pond at night, ink-wash style, deep teal water",
  style_terms: ["ukiyo-e"],
  palette: ["deep teal", "black", "gold"],
  ...overrides
});

// -----------------------------------------------------------------------------
// Checks.
// -----------------------------------------------------------------------------

let failures = 0;
const check = (name: string, condition: boolean, detail = "") => {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
};

const main = async () => {
  console.log("\n== 1. Refusals cost zero paid calls ==");
  {
    const { deps, provider, media, mockups } = makeDeps(null);
    const result = await runExpress(
      { input_as_text: "A hoodie with the Nike swoosh logo on it" },
      deps
    );
    check("blocked brand request is refused", result.status === "refused");
    check("refusal spent 0 LLM calls", provider.structuredCalls === 0 && provider.captionCalls === 0);
    check("refusal spent 0 image generations", media.generateCalls === 0);
    check("refusal called no mockup service", mockups.calls.length === 0);
    check(
      "screen catches hate symbols too",
      screenRequest("a swastika flag design").blocked === true
    );
  }

  console.log("\n== 2. AOP hoodie: full coverage at 1 LLM call + 1 generation ==");
  {
    const { deps, provider, media, mockups } = makeDeps(
      intentFor({ product_query: "hoodie", coverage: "full" })
    );
    const result = await runExpress(
      { input_as_text: "A bioluminescent koi pond hoodie, ink wash style" },
      deps
    );
    check("run completed", result.status === "completed", result.message);
    check("matched product 388", result.product.id === 388);
    check("strategy is master_slice", result.strategy === "master_slice");
    const successPanels = result.panels.filter((panel) => panel.status === "success");
    check(
      "all 6 renderable placements produced files",
      successPanels.length === 6,
      successPanels.map((panel) => panel.placement).join(",")
    );
    check(
      "label placement excluded from the plan",
      !result.panels.some((panel) => panel.placement.includes("label"))
    );
    check("exactly 1 structured LLM call", provider.structuredCalls === 1);
    check("exactly 1 image generation (master)", media.generateCalls === 1, `got ${media.generateCalls}`);
    check("official mockups returned", result.mockups.length > 0);
    const payload = mockups.calls[0];
    check(
      "mockup payload submits every renderable placement",
      payload.placements.length === 6 &&
        payload.placements.every((p) => p.technique === "cut-sew")
    );
    check("style ids capped at 2 from primary placement", payload.styleIds.join(",") === "11,12");
    check(
      "stitch_color resolved deterministically (dark palette -> black)",
      payload.productOptions?.stitch_color === "black"
    );
    check("variant resolved through truth source", result.product.variant_id === 388001);
    check(
      "economics: estimated AI cost under $0.15",
      result.economics.estimated_ai_cost_usd > 0 && result.economics.estimated_ai_cost_usd < 0.15,
      `$${result.economics.estimated_ai_cost_usd}`
    );
    check(
      "economics: positive margin anchor",
      result.economics.estimated_margin_anchor_usd > 10,
      `$${result.economics.estimated_margin_anchor_usd}`
    );
  }

  console.log("\n== 3. Non-AOP tee: margin rule plans primary placement only ==");
  {
    const { deps, media, mockups } = makeDeps(
      intentFor({ product_query: "t-shirt", coverage: "full" })
    );
    const result = await runExpress({ input_as_text: "a koi fish t-shirt" }, deps);
    check("run completed", result.status === "completed", result.message);
    check("matched product 71", result.product.id === 71);
    check("single front panel planned (DTG extra placements cost money)", result.panels.length === 1);
    check("strategy collapses to direct", result.strategy === "direct");
    check("one generation for one panel", media.generateCalls === 1);
    check(
      "mockup payload: 1 dtg placement",
      mockups.calls[0].placements.length === 1 && mockups.calls[0].placements[0].technique === "dtg"
    );
    check("no product options sent when product has none", mockups.calls[0].productOptions === undefined);
  }

  console.log("\n== 4. Explicit product_id override beats keywords ==");
  {
    const { deps } = makeDeps(intentFor({ product_query: "hoodie" }));
    const result = await runExpress(
      { input_as_text: "koi hoodie art", product_id: 19 },
      deps
    );
    check("picker product wins over keyword match", result.product.id === 19);
    check("run completed on mug", result.status === "completed", result.message);
  }

  console.log("\n== 5. LLM outage degrades to heuristic, run survives ==");
  {
    const { deps, media } = makeDeps(null, { failLLM: true });
    const result = await runExpress(
      { input_as_text: "a repeating seamless pattern of koi fish on a hoodie" },
      deps
    );
    check("run completed despite LLM outage", result.status === "completed", result.message);
    check("degraded intent flagged", result.degraded_intent === true);
    check("heuristic detected repeat pattern", result.strategy === "pattern_tile");
    check("still exactly 1 generation (the tile)", media.generateCalls === 1);
  }

  console.log("\n== 6. Mockup-service failure preserves paid work ==");
  {
    const { deps } = makeDeps(intentFor({ product_query: "hoodie" }), {
      mockupOutcome: "failed"
    });
    const result = await runExpress({ input_as_text: "koi pond hoodie" }, deps);
    check("status is mockup_failed (not failed)", result.status === "mockup_failed");
    check(
      "generated panels retained for retry",
      result.panels.filter((panel) => panel.status === "success").length === 6
    );
    check("no invented mockup urls", result.mockups.length === 0);
  }

  console.log("\n== 7. Deterministic helpers ==");
  {
    check("'all-over tee' matches 257 (longest keyword wins)", matchExpressProduct("an all-over tee").productId === 257);
    check("'tee' matches 71", matchExpressProduct("a cool tee").productId === 71);
    check("unmatched text defaults to 71", matchExpressProduct("something wonderful").productId === 71);
    check(
      "light palette -> white stitches",
      pickStitchColor(intentFor({ palette: ["cream", "pastel pink", "navy"] })) === "white"
    );
    check(
      "dark palette -> black stitches",
      pickStitchColor(intentFor({ palette: ["black", "crimson"] })) === "black"
    );
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
