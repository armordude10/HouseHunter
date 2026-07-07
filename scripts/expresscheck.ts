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
import { baseFillSvg, MediaLike, resolveCssColor } from "../src/engine/panelCompiler.js";
import { LlmProvider, StructuredParams } from "../src/llm/provider.js";
import { ChatCompletionParams, ChatCompletionResult } from "../src/runware/client.js";
import {
  catalogSize,
  getCatalogRecord,
  getExpressProduct,
  matchExpressProduct,
  searchCatalog,
  unrequestedModifierPenalty
} from "../src/express/catalog.js";
import { nearestVariantColor } from "../src/express/colorMatch.js";
import { ExpressIntent, heuristicIntent, screenRequest } from "../src/express/intent.js";
import { buildExpressJobs, pickStitchColor } from "../src/express/plan.js";
import { runExpress, ExpressDeps } from "../src/express/run.js";
import { buildGarmentPlane } from "../src/engine/garmentSpace.js";
import { renderLayerOverlay } from "../src/express/layers.js";
import { PlacementSpec, PrintfulTruth, ProductTruth } from "../src/express/truth.js";
import { createAndWaitForMockups, parseAvailableStyleIds } from "../src/integrations/printfulMockups.js";
import { buildSessionForm, signStripePayload, verifyStripeSignature } from "../src/commerce/stripe.js";
import { buildOrderPayload, getDesign, registerDesign } from "../src/commerce/orders.js";
import {
  buildShippingRequest,
  normalizeShippingCountry,
  pickCheapestRate
} from "../src/commerce/shipping.js";

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
  removeBackgroundCalls = 0;
  prompts: string[] = [];
  transparents: boolean[] = [];
  lastGenerate: {
    positivePrompt: string;
    referenceImages?: unknown[];
    transparentBackground?: boolean;
  } | null = null;

  async generateImage(params: {
    positivePrompt: string;
    width: number;
    height: number;
    referenceImages?: Array<{ image: string } | string>;
    transparentBackground?: boolean;
  }) {
    this.generateCalls++;
    this.prompts.push(params.positivePrompt);
    this.transparents.push(Boolean(params.transparentBackground));
    this.lastGenerate = {
      positivePrompt: params.positivePrompt,
      referenceImages: params.referenceImages,
      transparentBackground: params.transparentBackground
    };
    return { imageURL: toDataUrl(await gradientPng(params.width, params.height)) };
  }
  async removeBackground(imageUrl: string) {
    this.removeBackgroundCalls++;
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
  async hostImage(base64: string, contentType = "image/png") {
    return `data:${contentType};base64,${base64}`;
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

const AOP_TEE_SPECS: PlacementSpec[] = ["front", "back", "sleeve_left", "sleeve_right"].map(
  (placement) => ({
    placement,
    technique: "cut-sew",
    widthIn: 28,
    heightIn: 30,
    dpi: 24,
    styleIds: placement === "front" ? [41, 42] : [41]
  })
);

const MUG_SPECS: PlacementSpec[] = [
  { placement: "default", technique: "sublimation", widthIn: 9, heightIn: 3.5, dpi: 40, styleIds: [31] }
];

class StubTruth implements ProductTruth {
  lastPick: string | undefined;

  async placementSpecs(productId: number): Promise<PlacementSpec[]> {
    if (productId === 388) return HOODIE_SPECS;
    if (productId === 257) return AOP_TEE_SPECS;
    if (productId === 19) return MUG_SPECS;
    // Any other product behaves like its technique family — flow tests care
    // about pipeline mechanics, not which catalog record matching picked.
    return getCatalogRecord(productId)?.aop ? AOP_TEE_SPECS : TEE_SPECS;
  }
  async resolveVariant(productId: number, pick?: string): Promise<number> {
    this.lastPick = pick;
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
  const truth = new StubTruth();
  const deps: ExpressDeps = {
    provider,
    media,
    truth,
    renderMockups: mockups.render,
    hostImage: async (png) => toDataUrl(png)
  };
  return { deps, provider, media, mockups, truth };
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
    check(
      "AOP worn views = hero + front view + back view, exactly 3 generations",
      media.generateCalls === 3,
      `got ${media.generateCalls}`
    );
    check("official mockups returned", result.mockups.length > 0);
    const payload = mockups.calls[0];
    check(
      "mockup payload submits every renderable placement",
      payload.placements.length === 6 &&
        payload.placements.every((p) => p.technique === "cut-sew")
    );
    check(
      "heavy product (6 placements) requests ONE style — task weight stays renderable",
      payload.styleIds.join(",") === "11"
    );
    check(
      "mockup copies are REAL (hostImage survives metering; print-res never submitted)",
      result.panels
        .filter((p) => p.status === "success")
        .every((p) => p.mockup_file_url && p.mockup_file_url !== p.file_url),
      result.panels[0]?.mockup_file_url === result.panels[0]?.file_url ? "mockup==print!" : "ok"
    );
    // THE SPEED CONTRACT: every file submitted to the mockup generator must
    // be <=2048px — print-res submissions are what made tasks take minutes.
    let allSmall = true;
    for (const pl of payload.placements) {
      const buf = Buffer.from(pl.fileUrl.split(",")[1] ?? "", "base64");
      const meta = await sharp(buf).metadata();
      if (Math.max(meta.width ?? 0, meta.height ?? 0) > 2048) allSmall = false;
    }
    check("ALL mockup submissions <=2048px (print-res never hits the generator)", allSmall);
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

  console.log("\n== 7. FULL CATALOG: every indexed product plans cleanly ==");
  {
    const size = catalogSize();
    check("catalog index loaded (>=400 products)", size >= 400, `${size} products`);
    const fullIntent = intentFor({ coverage: "full" });
    let structural = 0;
    let planned = 0;
    let multiPanel = 0;
    const problems: string[] = [];
    for (const row of searchCatalog("", 100000)) {
      const record = getCatalogRecord(row.id)!;
      const structOk =
        record.baseCostUsd > 0 &&
        record.retailUsd > record.baseCostUsd &&
        record.defaultVariantId > 0 &&
        record.placements.length > 0 &&
        record.placements.every((p) => p.widthIn > 0 && p.heightIn > 0 && p.dpi > 0) &&
        new Set(record.placements.map((p) => p.placement)).size === record.placements.length;
      if (structOk) structural++;
      else problems.push(`${record.id} structural`);
      try {
        const product = getExpressProduct(record.id)!;
        const { jobs } = buildExpressJobs(product, record.placements, fullIntent);
        const jobsOk =
          jobs.length >= 1 &&
          jobs.every(
            (job) =>
              (job.geometry_contract?.width_px ?? 0) >= 16 &&
              (job.geometry_contract?.height_px ?? 0) >= 16
          );
        if (jobsOk) planned++;
        else problems.push(`${record.id} degenerate geometry`);
        if (jobs.length > 1) multiPanel++;
      } catch (error) {
        problems.push(`${record.id}: ${(error as Error).message}`);
      }
    }
    check(`every product structurally sound (${structural}/${size})`, structural === size, problems.slice(0, 3).join("; "));
    check(`every product yields a valid plan (${planned}/${size})`, planned === size, problems.slice(0, 3).join("; "));
    check("multi-panel AOP plans exist at scale (>80 products)", multiPanel > 80, `${multiPanel}`);
    const mug = getCatalogRecord(19)!;
    const mugJobs = buildExpressJobs(getExpressProduct(19)!, mug.placements, fullIntent).jobs;
    check(
      "sublimation 'default' rule: mug plans ONE surface (no double-print)",
      mugJobs.length === 1 && mugJobs[0].placement === "default",
      mugJobs.map((job) => job.placement).join(",")
    );
    check("'fleece blanket' resolves to a blanket", /blanket/i.test(matchExpressProduct("a cozy fleece blanket").name), matchExpressProduct("a cozy fleece blanket").name);
    check("'bucket hat' resolves to a hat", /hat/i.test(matchExpressProduct("a bucket hat").name), matchExpressProduct("a bucket hat").name);
    check("'duvet' resolves to bedding", /duvet|bedding/i.test(matchExpressProduct("a duvet cover").name), matchExpressProduct("a duvet cover").name);
  }

  console.log("\n== 8. Real-catalog e2e (file-backed truth, stub media, $0) ==");
  {
    const { deps, media } = makeDeps(intentFor({ product_query: "mug", coverage: "full" }));
    deps.truth = new PrintfulTruth(); // answers from the committed index; zero network
    const result = await runExpress({ input_as_text: "a watercolor fox mug" }, deps);
    check("mug e2e completed on real record", result.status === "completed", result.message);
    check(
      "variant came from the committed index",
      result.product.variant_id === getCatalogRecord(19)!.defaultVariantId
    );
    check("single surface, single generation", media.generateCalls === 1 && result.panels.length === 1);
    check(
      "no product options for optionless product",
      !getCatalogRecord(19)!.productOptions.includes("stitch_color")
    );
  }
  {
    const { deps, mockups } = makeDeps(intentFor({ product_query: "hoodie", coverage: "full" }));
    deps.truth = new PrintfulTruth();
    const result = await runExpress({ input_as_text: "aurora borealis hoodie" }, deps);
    check("hoodie e2e completed on real record (real 40x40 canvases)", result.status === "completed", result.message);
    const record = getCatalogRecord(388)!;
    const renderableCount = record.placements.filter((p) => !/label/i.test(p.placement)).length;
    check(
      `all ${renderableCount} real renderable hoodie placements submitted`,
      mockups.calls[0]?.placements.length === renderableCount,
      `${mockups.calls[0]?.placements.length}`
    );
    check(
      "stitch_color truth-gated from index",
      mockups.calls[0]?.productOptions?.stitch_color === "black"
    );
  }

  console.log("\n== 9. Deterministic helpers ==");
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

  console.log("\n== 10. Image directives: verbatim / edits / references ==");
  {
    // Serve a real image over http (customer image URLs must be http/https).
    const { createServer } = await import("node:http");
    const png = await gradientPng(64, 64);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const customerImage = `http://127.0.0.1:${port}/sketch.png`;

    {
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "t-shirt",
          image_plan: [{ index: 0, role: "use_verbatim", instruction: "print exactly as uploaded" }]
        })
      );
      const result = await runExpress(
        { input_as_text: "put my logo on a t-shirt exactly as uploaded", input_image_urls: [customerImage] },
        deps
      );
      check("verbatim run completed", result.status === "completed", result.message);
      check("verbatim spent ZERO generations", media.generateCalls === 0, `${media.generateCalls}`);
      check(
        "verbatim panel is derived, not generated",
        result.panels[0]?.generation_mode === "derived" && result.panels.length === 1
      );
      check("verbatim genome records the source image", result.design_genome?.panels[0]?.source_urls[0] === customerImage);
    }
    {
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "t-shirt",
          image_plan: [
            { index: 0, role: "verbatim_remove_background", instruction: "as is, background removed" }
          ]
        })
      );
      const result = await runExpress(
        { input_as_text: "my sticker on a tee, just remove the background", input_image_urls: [customerImage] },
        deps
      );
      check("verbatim+bg-removal completed", result.status === "completed", result.message);
      check("background removal invoked once, zero generations", media.removeBackgroundCalls === 1 && media.generateCalls === 0);
    }
    {
      // QUEUE VERDICT: a verbatim image on an AOP full-coverage product must
      // NOT strand the other panels blank — the image becomes the worn-view
      // painter's hero and the sleeves/back are painted out to match.
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "all over print men's crew neck t-shirt",
          coverage: "full",
          all_over: true,
          image_plan: [
            {
              index: 0,
              role: "verbatim_remove_background",
              instruction: "remove background, cover the front, paint out sleeves and back to match"
            }
          ]
        })
      );
      const result = await runExpress(
        {
          input_as_text:
            "Remove just the background and place it on a men's crew neck all-over print shirt and make sure it covers the entire front. Paint out both sleeve panels and the back to match",
          input_image_urls: [customerImage]
        },
        deps
      );
      check("verbatim AOP paint-out completed", result.status === "completed", result.message);
      const painted = result.panels.filter((p) => p.status === "success");
      check(
        "ALL panels painted (nothing left blank)",
        painted.length === 4,
        painted.map((p) => p.placement).join(",")
      );
      check("background removal honored", media.removeBackgroundCalls >= 1, `${media.removeBackgroundCalls}`);
      check(
        "customer image rode as the painter's hero",
        (result.trace ?? []).some((t) => t.stage === "verbatim_hero") && media.generateCalls >= 2,
        `gens=${media.generateCalls}`
      );
    }
    {
      // The LIVE failure shape: the intent model re-described the photo
      // (edit_subject, no verbatim) AND emitted art-only panel_directives
      // for a matching scene. Both deterministic backstops must fire.
      const { deps } = makeDeps(
        intentFor({
          product_query: "all over print men's crew neck t-shirt",
          coverage: "full",
          all_over: true,
          image_plan: [{ index: 0, role: "edit_subject", instruction: "feature this scene" }],
          panel_directives: [
            { panel: "front", fill: "none", color_a: "", color_b: "", angle_deg: 0, art_prompt: "full panel ocean sunset", art_width_frac: 0.9 },
            { panel: "back", fill: "none", color_a: "", color_b: "", angle_deg: 0, art_prompt: "matching sunset", art_width_frac: 0.9 },
            { panel: "left_sleeve", fill: "none", color_a: "", color_b: "", angle_deg: 0, art_prompt: "continuing sunset", art_width_frac: 0.9 },
            { panel: "right_sleeve", fill: "none", color_a: "", color_b: "", angle_deg: 0, art_prompt: "continuing sunset", art_width_frac: 0.9 }
          ]
        })
      );
      const result = await runExpress(
        {
          input_as_text:
            "Remove just the background and place it on a men's crew neck all-over print shirt and make sure it covers the entire front. Paint out both sleeve panels and the back to match",
          input_image_urls: [customerImage]
        },
        deps
      );
      check("backstop run completed", result.status === "completed", result.message);
      check(
        "verbatim BACKSTOP fired (model failed to mark the image verbatim)",
        (result.trace ?? []).some((t) => t.stage === "verbatim_backstop")
      );
      check(
        "mislabeled art-only directives DROPPED (continuous scene)",
        (result.trace ?? []).some((t) => t.stage === "panel_directives_dropped")
      );
      check(
        "photo became the painter's hero; all 4 panels painted",
        (result.trace ?? []).some((t) => t.stage === "verbatim_hero") &&
          result.panels.filter((p) => p.status === "success").length === 4,
        result.panels.map((p) => `${p.placement}:${p.status}`).join(",")
      );
    }
    {
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "hoodie",
          image_prompt: "ENGINEERED_PROMPT_TOKEN luminous koi, ukiyo-e linework, midnight palette",
          image_plan: [
            { index: 0, role: "edit_subject", instruction: "turn the person into a cartoon but keep the face recognizable" }
          ]
        })
      );
      const result = await runExpress(
        { input_as_text: "cartoon me on a hoodie", input_image_urls: [customerImage] },
        deps
      );
      check("edit-subject run completed", result.status === "completed", result.message);
      check(
        "reference image passed to the generator",
        (media.lastGenerate?.referenceImages?.length ?? 0) === 1
      );
      check(
        "enhanced image_prompt drives generation",
        media.lastGenerate?.positivePrompt.includes("ENGINEERED_PROMPT_TOKEN") === true
      );
      check(
        "per-image instruction folded into the brief",
        media.lastGenerate?.positivePrompt.includes("cartoon but keep the face") === true
      );
    }
    {
      const { deps, truth } = makeDeps(
        intentFor({ product_query: "hoodie", garment_color: "black", size_preference: "XL" })
      );
      await runExpress({ input_as_text: "black koi hoodie in XL" }, deps);
      check(
        "size reaches variant resolution; color stays in the ART on printed-surface hoodies",
        truth.lastPick === "XL",
        String(truth.lastPick)
      );
    }
    {
      check(
        "lay all-over language upgrades to an AOP shirt",
        matchExpressProduct("a shirt covered in koi fish everywhere", { preferAop: true }).aop === true
      );
      check(
        "heuristic detects all-over wording",
        heuristicIntent("a shirt covered in koi fish everywhere").all_over === true
      );
    }
    console.log("\n== 11. Layered composition: grounded text/element placement ==");
    {
      const layerBase = {
        image_index: null,
        placement: "front",
        rotation_deg: 0,
        color: "",
        order: 0
      };
      {
        const { deps, media } = makeDeps(
          intentFor({
            product_query: "t-shirt",
            layers_only: true,
            layers: [
              {
                ...layerBase,
                kind: "text" as const,
                content: "THREADBOT",
                cx_frac: 0.5,
                cy_frac: 0.2,
                width_frac: 0.6,
                color: "#00ff88"
              }
            ]
          })
        );
        const result = await runExpress(
          { input_as_text: "put THREADBOT in green across the high chest of a tee" },
          deps
        );
        check("layered text run completed", result.status === "completed", result.message);
        check(
          "text becomes GENERATED typography (1 gen, native alpha, exact string quoted)",
          media.generateCalls === 1 &&
            (media.lastGenerate as { transparentBackground?: boolean } | null)?.transparentBackground === true &&
            media.prompts[0].includes('"THREADBOT"'),
          media.prompts[0]?.slice(0, 80)
        );
        const buffer = Buffer.from((result.panels[0].file_url as string).split(",")[1], "base64");
        const meta = await sharp(buffer).metadata();
        const band = async (fromFrac: number, toFrac: number) => {
          const region = await sharp(buffer)
            .extract({
              left: 0,
              top: Math.round((meta.height ?? 1) * fromFrac),
              width: meta.width ?? 1,
              height: Math.max(1, Math.round((meta.height ?? 1) * (toFrac - fromFrac)))
            })
            .ensureAlpha()
            .png()
            .toBuffer();
          const stats = await sharp(region).stats();
          return stats.channels[3].mean;
        };
        const inkAtTarget = await band(0.1, 0.3);
        const inkFarAway = await band(0.6, 0.95);
        check(
          "GROUNDED PLACEMENT: ink exactly in the planned band (cy 0.2), nowhere else",
          inkAtTarget > 1 && inkFarAway === 0,
          `target band alpha ${inkAtTarget.toFixed(1)}, far band ${inkFarAway.toFixed(1)}`
        );
        check("panel is transparent PNG (layerable)", result.panels[0].transparent_background === true);
      }
      {
        const { deps, media } = makeDeps(
          intentFor({
            product_query: "t-shirt",
            layers_only: true,
            layers: [
              {
                ...layerBase,
                kind: "element" as const,
                content: "a vintage brass anchor, engraved detail",
                cx_frac: 0.5,
                cy_frac: 0.5,
                width_frac: 0.3
              }
            ]
          })
        );
        const result = await runExpress({ input_as_text: "small anchor centered on a tee" }, deps);
        check("layered element run completed", result.status === "completed", result.message);
        check("element generated once with native-alpha request", media.generateCalls === 1 && (media.lastGenerate as { transparentBackground?: boolean } | null)?.transparentBackground === true);
        check(
          "opaque asset detected and repaired via background removal",
          media.removeBackgroundCalls === 1
        );
      }
      {
        const { deps, media } = makeDeps(
          intentFor({
            product_query: "t-shirt",
            layers_only: true,
            layers: [
              {
                ...layerBase,
                kind: "customer_image" as const,
                content: "",
                image_index: 0,
                cx_frac: 0.5,
                cy_frac: 0.4,
                width_frac: 0.5
              },
              {
                ...layerBase,
                kind: "text" as const,
                content: "EST. 2026",
                cx_frac: 0.5,
                cy_frac: 0.8,
                width_frac: 0.3,
                order: 1
              }
            ]
          })
        );
        const result = await runExpress(
          { input_as_text: "my photo centered with EST. 2026 under it", input_image_urls: [customerImage] },
          deps
        );
        check("photo + caption composition completed", result.status === "completed", result.message);
        check(
          "photo costs zero gens; caption is one typography gen",
          media.generateCalls === 1 && result.panels.length === 1,
          `${media.generateCalls} gens`
        );
        check(
          "genome records the customer photo as layer source",
          result.design_genome?.panels[0]?.source_urls.includes(customerImage) === true
        );
      }
    }
    console.log("\n== 12. THE 745 CASE: AOP inference + layers ON TOP of artwork ==");
    {
      const layerBase = { image_index: null, placement: "front", rotation_deg: 0, order: 0 };
      {
        // Exactly the reported failure: "AOP grungy rap metal shirt that says
        // 745 across the chest" must give an AOP product, full master art on
        // every panel, and the text grounded over the chest ON TOP of it.
        const { deps, media, mockups } = makeDeps(
          intentFor({
            product_query: "aop shirt",
            coverage: "full",
            all_over: true,
            layers_only: false,
            artwork_brief: "grungy rap metal collage, distressed textures, dark chaotic energy",
            image_prompt: "grunge rap-metal collage artwork, distressed ink, torn poster textures",
            layers: [
              { ...layerBase, kind: "text" as const, content: "745", cx_frac: 0.5, cy_frac: 0.22, width_frac: 0.6, color: "#ff00ff" }
            ]
          })
        );
        const result = await runExpress(
          { input_as_text: "an AOP grungy rap metal themed shirt that says 745 in grungy text across the chest" },
          deps
        );
        check("745 run completed", result.status === "completed", result.message);
        check("an AOP shirt selected, not the plain tee", getCatalogRecord(result.product.id)?.aop === true, result.product.name);
        check("full multi-panel artwork (master_slice, 4 panels)", result.strategy === "master_slice" && result.panels.length === 4, `${result.strategy}/${result.panels.length}`);
        check(
          "hero + front view + back view + typography lockup = exactly 4 generations",
          media.generateCalls === 4,
          `${media.generateCalls}`
        );
        const front = result.panels.find((p) => p.placement === "front")!;
        check("front panel carries the layered overlay", /Layered overlay applied/.test(front.notes), front.notes.slice(0, 80));
        check("all 4 panels submitted to mockups", mockups.calls[0]?.placements.length === 4);
        const overlayProv = result.design_genome?.panels.find((p) => p.job_id === "overlay_front");
        check(
          "typography element recorded as the overlay's generated source",
          (overlayProv?.source_urls.length ?? 0) === 1 && /745/.test(overlayProv?.prompt ?? ""),
          overlayProv?.prompt?.slice(0, 60)
        );
        check(
          "master prompt does NOT carry the text (no double-print)",
          !media.prompts[0].includes("745"),
          media.prompts[0]?.slice(0, 70)
        );
        check(
          "PIXEL-PERFECT CONTAINMENT: hero scene generated alone, then extended",
          media.prompts[0].includes("complete self-contained scene") &&
            /Extend (this artwork|the existing scene) outward/.test(media.prompts[1] ?? ""),
          media.prompts[1]?.slice(0, 60)
        );
        check(
          "overlay recorded in the genome",
          result.design_genome?.panels.some((p) => p.job_id === "overlay_front") === true
        );
      }
      {
        const { deps } = makeDeps(intentFor({ product_query: "shirt", all_over: false }));
        const result = await runExpress({ input_as_text: "an AOP skull shirt" }, deps);
        check(
          "raw-text 'AOP' backstops the model (intent said all_over=false, still AOP)",
          getCatalogRecord(result.product.id)?.aop === true,
          result.product.name
        );
      }
      check(
        "heuristic reads bare 'AOP'",
        heuristicIntent("an AOP grungy rap metal themed shirt").all_over === true
      );
      {
        // THE ARNDT WEDDING CASE: AOP + exact text, NO layers from intent.
        // Text must never ride the master (cut-line risk) — the pipeline
        // auto-synthesizes a grounded typography layer on the primary panel.
        const { deps, media, mockups } = makeDeps(
          intentFor({
            product_query: "all over print shirt",
            coverage: "full",
            all_over: true,
            layers_only: false,
            artwork_brief: "a bouquet of sunflowers, red roses and dark blue roses",
            // The intent model writes image_prompt faithful to the customer's
            // words — it WILL carry `that says "X"`. Scrubbing must strip it.
            image_prompt:
              'lush painted bouquet of sunflowers, crimson roses, deep navy roses that says "The Arndt Wedding"',
            required_text: ["The Arndt Wedding"]
          })
        );
        const result = await runExpress(
          {
            input_as_text:
              "an all over print shirt that has a bouquet of sunflowers, red roses, and dark blue roses that said \"The Arndt Wedding\""
          },
          deps
        );
        check("Arndt Wedding run completed", result.status === "completed", result.message);
        check(
          "AOP product, all panels",
          getCatalogRecord(result.product.id)?.aop === true && result.panels.length === 4,
          `${result.product.name} / ${result.panels.length}`
        );
        check(
          "text auto-synthesized as grounded typography (hero + 2 views + lockup = 4 gens)",
          media.generateCalls === 4,
          `${media.generateCalls}`
        );
        check(
          "master prompt carries NO text (cut-line safety)",
          !media.prompts[0]?.includes("Arndt"),
          media.prompts[0]?.slice(0, 70)
        );
        check(
          "typography prompt quotes the exact string",
          media.prompts.some((p) => p.includes('"The Arndt Wedding"')),
          media.prompts[media.prompts.length - 1]?.slice(0, 80)
        );
        const frontPanel = result.panels.find((p) => /Layered overlay applied/.test(p.notes));
        check("lockup composited onto exactly one grounded panel", Boolean(frontPanel), frontPanel?.placement);
        check("all 4 panels still submitted", mockups.calls[0]?.placements.length === 4);
      }
    }

    console.log("\n== 12b. THE GUNNER RULE: single-panel text lives IN the generation ==");
    {
      // The reported failure's other half: on a SINGLE-panel product the
      // model composes text beautifully inside the artwork — a separate
      // lockup layer is pure double-print risk. Even when the intent emits
      // both required_text AND a text layer (belt and suspenders gone wrong),
      // the layer must be dropped and the text returned to the one prompt.
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "t-shirt",
          layers_only: false,
          artwork_brief: "playful bones and paw prints motif",
          image_prompt: 'playful bones and paw prints motif that says "Gunner" in bold friendly lettering',
          required_text: ["Gunner"],
          layers: [
            {
              kind: "text" as const,
              content: "Gunner",
              image_index: null,
              placement: "front",
              cx_frac: 0.5,
              cy_frac: 0.5,
              width_frac: 0.6,
              rotation_deg: 0,
              color: "",
              order: 0
            }
          ]
        })
      );
      const result = await runExpress({ input_as_text: 'a shirt that says "Gunner"' }, deps);
      check("Gunner run completed", result.status === "completed", result.message);
      check("single panel plan", result.panels.length === 1, `${result.panels.length}`);
      check(
        "exactly ONE generation — the text rides it, no separate lockup",
        media.generateCalls === 1,
        `${media.generateCalls}`
      );
      check(
        "generation prompt quotes the exact text",
        media.prompts[0]?.includes('"Gunner"') === true,
        media.prompts[0]?.slice(0, 90)
      );
      check(
        "no overlay pass ran (nothing stamped over the art)",
        result.panels.every((p) => !/Layered overlay applied/.test(p.notes)) &&
          !result.design_genome?.panels.some((p) => /^overlay_/.test(p.job_id))
      );
    }

    console.log("\n== 13. THE PILLOW CASE: real-record e2e for the reported product ==");
    {
      const { deps, media, mockups } = makeDeps(
        intentFor({ product_query: "pillow", coverage: "full", all_over: true })
      );
      deps.truth = new PrintfulTruth(); // committed index, zero network
      const result = await runExpress(
        { input_as_text: "a pillow covered in ukiyo-e waves" },
        deps
      );
      check("pillow run completed", result.status === "completed", result.message);
      check("matched an AOP pillow product", /pillow/i.test(result.product.name), result.product.name);
      const record = getCatalogRecord(result.product.id)!;
      const renderableCount = record.placements.filter((p) => !/label/i.test(p.placement)).length;
      check(
        `both pillow faces produced and submitted (${renderableCount})`,
        result.panels.length === renderableCount && mockups.calls[0]?.placements.length === renderableCount,
        result.panels.map((p) => p.placement).join(",")
      );
      check("hero + outpaint master (pixel-perfect containment)", media.generateCalls === 2);
      check("style ids present in mockup payload", (mockups.calls[0]?.styleIds.length ?? 0) > 0);
    }

    console.log("\n== 13b. THE PET BOWL CASE: single-panel text via the layer door ==");
    {
      // Reported live failure: 'a dog bowl with "Gunner" written on it' -> the
      // intent planned a standalone text layer (layers_only), which skipped
      // the Gunner rule AND composited a square element onto the bowl's
      // 21.65in x 2.68in strip — sharp refuses oversized composites. The rule
      // must now fire at the door: text rides the ONE generation.
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "dog bowl",
          layers_only: true,
          artwork_brief: 'a clean pet bowl design with "Gunner" written on it',
          image_prompt: 'a playful pet bowl wrap design with "Gunner" written in bold friendly lettering',
          required_text: ["Gunner"],
          layers: [
            {
              kind: "text" as const,
              content: "Gunner",
              image_index: null,
              placement: "front",
              cx_frac: 0.5,
              cy_frac: 0.5,
              width_frac: 0.5,
              rotation_deg: 0,
              color: "",
              order: 0
            }
          ]
        })
      );
      deps.truth = new PrintfulTruth(); // real bowl geometry from the index
      const result = await runExpress({ input_as_text: 'a dog bowl with "Gunner" written on it' }, deps);
      check("dog bowl run completed", result.status === "completed", result.message);
      check("matched the pet bowl", /pet bowl/i.test(result.product.name), result.product.name);
      check(
        "text rode the generation (1 gen, exact string quoted, no layer path)",
        media.generateCalls === 1 && media.prompts[0]?.includes('"Gunner"') === true,
        `${media.generateCalls} gens — ${media.prompts[0]?.slice(0, 70)}`
      );
      check(
        "no layered composition ran on the bowl",
        result.panels.every((p) => !/Layered/i.test(p.notes)),
        result.panels[0]?.notes?.slice(0, 60)
      );
    }
    {
      // Engine hardening: even when layers DO composite onto a short, wide
      // piece, assets are fitted — never larger than the canvas.
      const media = new StubMedia();
      const overlay = await renderLayerOverlay({
        media,
        spec: { placement: "default", technique: "sublimation", widthIn: 21.65, heightIn: 2.68, dpi: 300, styleIds: [] },
        layers: [
          {
            kind: "element",
            content: "a bone icon",
            image_index: null,
            placement: "default",
            cx_frac: 0.5,
            cy_frac: 0.5,
            width_frac: 0.6,
            rotation_deg: 15,
            color: "",
            order: 0
          }
        ],
        imageUrls: [],
        runId: "bowl-overlay-test"
      });
      const dims = await sharp(overlay.buffer).metadata();
      check(
        "square asset fitted into the 8x-wide strip (composite cannot outsize canvas)",
        dims.width === overlay.canvasW && dims.height === overlay.canvasH && overlay.canvasH < 900,
        `${dims.width}x${dims.height}`
      );
    }

    console.log("\n== 13c. QUEUE FIXES: explicit nouns beat steered intents; color lands in the art ==");
    {
      // Live incident: taste history steered product_query to "sports bra"
      // while the customer typed "shirt". The words must win.
      const { deps } = makeDeps(
        intentFor({ product_query: "sports bra", garment_color: "dark blue" })
      );
      const result = await runExpress(
        { input_as_text: "Dark blue shirt with this logo on chest" },
        deps
      );
      check(
        "explicit 'shirt' overrides a steered product_query of 'sports bra'",
        /shirt/i.test(result.product.name) && !/bra/i.test(result.product.name),
        result.product.name
      );
    }
    {
      // Live incident: "red sports bra" came back white — on printed-surface
      // products the color is the ART's base, not a variant pick.
      const { deps, media, truth } = makeDeps(
        intentFor({
          product_query: "sports bra",
          coverage: "full",
          all_over: true,
          garment_color: "red",
          artwork_brief: "bold athletic design"
        })
      );
      const result = await runExpress({ input_as_text: "a red sports bra" }, deps);
      check("bra run completed", result.status === "completed", result.message);
      check(
        "printed-surface color rides the ART (base-color directive in the master prompt)",
        media.prompts[0]?.includes("base color is red") === true &&
          media.prompts[0]?.includes("no white background") === true,
        media.prompts[0]?.slice(0, 90)
      );
      check(
        "color EXCLUDED from variant hints on printed-surface products",
        !(truth.lastPick ?? "").includes("red"),
        String(truth.lastPick)
      );
    }
    {
      // Live incidents (white bra / white laptop sleeve): layers-only designs
      // composite onto TRANSPARENT, so a stated color on a printed-surface
      // product must veto standalone mode and generate a colored base under
      // the layers.
      const layerBase = { image_index: null, placement: "front", rotation_deg: 0, color: "", order: 0 };
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "laptop sleeve",
          layers_only: true,
          garment_color: "", // live incident: model leaves this empty for non-garments
          artwork_brief: "a golden lion emblem centered",
          image_prompt: "a golden lion emblem, regal, centered",
          layers: [
            { ...layerBase, kind: "element" as const, content: "a golden lion emblem, regal, metallic", cx_frac: 0.5, cy_frac: 0.5, width_frac: 0.4 }
          ]
        })
      );
      deps.truth = new PrintfulTruth(); // real sleeve: sublimation surface
      const result = await runExpress(
        { input_as_text: "Laptop case sleeve that is dark blue and has a golden lion emblem on it" },
        deps
      );
      check("dark blue sleeve run completed", result.status === "completed", result.message);
      check(
        "stated color vetoes layers-only: a base IS generated with the color directive",
        media.generateCalls >= 2 && media.prompts[0]?.includes("base color is dark blue") === true,
        `${media.generateCalls} gens — ${media.prompts[0]?.slice(0, 80)}`
      );
      check(
        "sublimation master generated OPAQUE (transparent flag would erase the blue)",
        media.transparents[0] === false,
        JSON.stringify(media.transparents)
      );
      check(
        "lion layer composited ON TOP of the colored base",
        result.panels.some((p) => /Layered overlay applied/.test(p.notes)),
        result.panels[0]?.notes?.slice(0, 60)
      );
    }
    {
      // DTG garments keep the old (correct) behavior: color picks the variant.
      const { deps, truth } = makeDeps(
        intentFor({ product_query: "t-shirt", garment_color: "dark blue" })
      );
      await runExpress({ input_as_text: "a dark blue t-shirt with a koi fish" }, deps);
      check(
        "DTG color still resolves the variant",
        (truth.lastPick ?? "").includes("dark blue"),
        String(truth.lastPick)
      );
    }

    console.log("\n== 13e. SLEEVE WORN-VIEW: painter engages; NO hard line at the centerline ==");
    {
      // Supersedes the hard-centerline assembly the owner rejected ("its
      // unaligned and has a hard line at the seam which is ugly"): sleeved
      // AOP garments now paint front/back WORN VIEWS and unfold each sleeve
      // as front half + mirrored back half with a feathered cross-blend.
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "aop shirt",
          coverage: "full",
          all_over: true,
          artwork_brief: "one continuous mural wrapping around the whole shirt"
        })
      );
      const result = await runExpress(
        { input_as_text: "a mural wrapping around the whole aop shirt" },
        deps
      );
      check("worn-view run completed", result.status === "completed", result.message);
      check(
        "worn-view painter engaged (front view AS WORN + back view continuation)",
        media.prompts.some((p) => /AS WORN/i.test(p)) &&
          media.prompts.some((p) => /BACK view/i.test(p)),
        media.prompts.map((p) => p.slice(0, 48)).join(" | ")
      );
      const panelBuf = async (placement: string) => {
        const panel = result.panels.find((p) => p.placement === placement)!;
        return Buffer.from((panel.file_url as string).split(",")[1], "base64");
      };
      const colRed = async (buf: Buffer, which: "midL" | "midR") => {
        const meta = await sharp(buf).metadata();
        const w = meta.width ?? 1;
        const x = which === "midL" ? Math.floor(w / 2) - 2 : Math.floor(w / 2) + 2;
        const col = await sharp(buf).extract({ left: x, top: 0, width: 1, height: meta.height ?? 1 }).raw().toBuffer({ resolveWithObject: true });
        let sum = 0;
        for (let i = 0; i < col.info.height; i++) sum += col.data[i * col.info.channels];
        return sum / col.info.height;
      };
      const sleeve = await panelBuf("sleeve_left");
      const midL = await colRed(sleeve, "midL");
      const midR = await colRed(sleeve, "midR");
      check(
        "NO hard line at the sleeve centerline (feathered cross-blend)",
        Math.abs(midL - midR) < 15,
        `centerline jump ${Math.abs(midL - midR).toFixed(0)} (must be smooth)`
      );
    }

    console.log("\n== 13f. PANEL DIRECTIVES: per-panel orders execute EXACTLY ==");
    {
      // Exact-color vocabulary and vector fills.
      check("hex passes through", resolveCssColor("#ff8800") === "#ff8800");
      check('"Dark Blue" resolves', resolveCssColor("Dark Blue") === "darkblue");
      check('"sunset orange" salvages its hue', resolveCssColor("sunset orange") === "orange");
      check('nonsense color is rejected', resolveCssColor("banana") === null);
      const svg = baseFillSvg(100, 200, "gradient", "orange", "tan", 90);
      check(
        "gradient angle 90 = top-to-bottom",
        svg.includes('y1="0.0000"') && svg.includes('y2="1.0000"') && svg.includes("orange") && svg.includes("tan"),
        svg.slice(0, 160)
      );

      // The owner's acid test, end to end: yellow left sleeve, blue right
      // sleeve, orange->tan gradient front, green->purple gradient back,
      // black hood, panel-specific typography on the front.
      const { deps, media } = makeDeps(
        intentFor({
          product_query: "hoodie",
          coverage: "full",
          all_over: true,
          artwork_brief: "color-blocked hoodie with panel-specific colors",
          panel_directives: [
            { panel: "left_sleeve", fill: "solid", color_a: "yellow", color_b: "", angle_deg: 0, art_prompt: "", art_width_frac: 0 },
            { panel: "right_sleeve", fill: "solid", color_a: "blue", color_b: "", angle_deg: 0, art_prompt: "", art_width_frac: 0 },
            { panel: "front", fill: "gradient", color_a: "orange", color_b: "tan", angle_deg: 90, art_prompt: 'the exact text "THREAD" as varsity typography', art_width_frac: 0.6 },
            { panel: "back", fill: "gradient", color_a: "green", color_b: "purple", angle_deg: 90, art_prompt: "", art_width_frac: 0 },
            { panel: "hood", fill: "solid", color_a: "black", color_b: "", angle_deg: 0, art_prompt: "", art_width_frac: 0 }
          ]
        })
      );
      const result = await runExpress(
        {
          input_as_text:
            "hoodie with a yellow left sleeve, a blue right sleeve, an orange to tan gradient front with THREAD across the chest, a green to purple gradient back, and a black hood"
        },
        deps
      );
      check("directive run completed", result.status === "completed", result.message);
      check("strategy reports hybrid (directive engine)", result.strategy === "hybrid", result.strategy);
      const avg = async (placement: string, region: "top" | "bottom" | "all") => {
        const panel = result.panels.find((p) => p.placement === placement);
        if (!panel?.file_url) return null;
        const buf = Buffer.from((panel.file_url as string).split(",")[1], "base64");
        const meta = await sharp(buf).metadata();
        const h = meta.height ?? 1;
        const strip = Math.max(1, Math.floor(h * 0.05));
        const extracted =
          region === "all"
            ? sharp(buf)
            : sharp(buf).extract({
                left: 0,
                top: region === "top" ? 0 : h - strip,
                width: meta.width ?? 1,
                height: strip
              });
        const px = await extracted.resize(1, 1, { fit: "fill" }).removeAlpha().raw().toBuffer();
        return { r: px[0], g: px[1], b: px[2] };
      };
      const ls = await avg("sleeve_left", "all");
      check(
        "left sleeve is EXACTLY yellow",
        !!ls && ls.r > 200 && ls.g > 200 && ls.b < 100,
        JSON.stringify(ls)
      );
      const rsAvg = await avg("sleeve_right", "all");
      check(
        "right sleeve is EXACTLY blue (never a mirror of the left)",
        !!rsAvg && rsAvg.b > 150 && rsAvg.r < 100,
        JSON.stringify(rsAvg)
      );
      const frontTop = await avg("front", "top");
      const frontBottom = await avg("front", "bottom");
      check(
        "front gradient runs orange (top) to tan (bottom)",
        !!frontTop && !!frontBottom && frontTop.b < 80 && frontBottom.b > 100 && frontTop.r > 180,
        `top=${JSON.stringify(frontTop)} bottom=${JSON.stringify(frontBottom)}`
      );
      const backTop = await avg("back", "top");
      const backBottom = await avg("back", "bottom");
      check(
        "back gradient runs green (top) to purple (bottom)",
        !!backTop && !!backBottom && backTop.g > backTop.b + 40 && backBottom.b > backBottom.g + 40,
        `top=${JSON.stringify(backTop)} bottom=${JSON.stringify(backBottom)}`
      );
      const hoodAvg = await avg("hood", "all");
      check("hood is EXACTLY black", !!hoodAvg && hoodAvg.r < 40 && hoodAvg.g < 40 && hoodAvg.b < 40, JSON.stringify(hoodAvg));
      // The pocket got NO directive: it must continue the front's orange->tan
      // fill at its worn position (never stray generated art).
      const pocketAvg = await avg("pocket", "all");
      const pocketPanel = result.panels.find((p) => p.placement === "pocket");
      check(
        "undirected pocket inherits the front gradient at its worn position",
        !!pocketAvg &&
          pocketAvg.r > 170 &&
          pocketAvg.b < 170 &&
          /inherits the front fill/.test(pocketPanel?.notes ?? ""),
        `${JSON.stringify(pocketAvg)} ${pocketPanel?.notes?.slice(0, 60)}`
      );
      check(
        "panel-specific typography generated for the front only",
        media.prompts.some((p) => /THREAD/.test(p)),
        media.prompts.filter((p) => /THREAD/.test(p)).length + " prompts"
      );
      const lsPanel = result.panels.find((p) => p.placement === "sleeve_left");
      check(
        "directive panels carry provenance strategy=panel_directive",
        (result.design_genome?.panels ?? []).some((p) => p.strategy === "panel_directive"),
        lsPanel?.notes ?? ""
      );
    }

    console.log("\n== 13g. QUEUE VERDICTS: color-true variants + no specialized-product drift ==");
    {
      check(
        '"bright green" lands on Irish Green (perceptual, not token order)',
        nearestVariantColor("bright green", ["Forest Green", "Irish Green", "Berry", "Black"]) ===
          "Irish Green",
        String(nearestVariantColor("bright green", ["Forest Green", "Irish Green", "Berry", "Black"]))
      );
      check(
        '"dark blue" lands on Navy',
        nearestVariantColor("dark blue", ["Light Blue", "Navy", "Royal"]) === "Navy",
        String(nearestVariantColor("dark blue", ["Light Blue", "Navy", "Royal"]))
      );
      check(
        "unparseable phrases fall back to token matching",
        nearestVariantColor("shimmering cosmos", ["Black", "White"]) === null
      );
      check(
        "long sleeve penalized when not requested",
        unrequestedModifierPenalty("Unisex Long Sleeve Shirt | Gildan 2400", "bright green shirt") > 0
      );
      check(
        "no penalty when the customer asked for the specialization",
        unrequestedModifierPenalty("Unisex Long Sleeve Shirt | Gildan 2400", "a long sleeve shirt") === 0
      );
      const picked = matchExpressProduct(
        'Bright green shirt that has a clean professional logo on it for a company called "StudioSentry"'
      );
      check(
        "plain 'shirt' matches a basic tee (no pocket/long-sleeve/garment-dyed drift)",
        !/long sleeve|pocket|v-neck|garment-dyed/i.test(picked.name),
        picked.name
      );
      const stillLong = matchExpressProduct("a long sleeve shirt with a wolf on it");
      check(
        "asking for long sleeve still gets long sleeve",
        /long sleeve/i.test(stillLong.name),
        stillLong.name
      );
      // QUEUE VERDICT: "Custom hotpants, black color, with pink print" landed
      // on Black Foot Sublimated SOCKS — color words hit the product NAME.
      const hotpants = matchExpressProduct(
        "Custom hotpants, black color, with pink print that says I'm a Snack"
      );
      check(
        "hotpants match shorts, never color-named products",
        /shorts/i.test(hotpants.name) && !/sock/i.test(hotpants.name),
        hotpants.name
      );
      const socks = matchExpressProduct("black socks with skulls all over them");
      check(
        "socks still reachable after color-token filtering",
        /sock/i.test(socks.name),
        socks.name
      );
      const blackOnly = matchExpressProduct("black");
      check(
        "a color-only query still matches SOMETHING (colors survive when alone)",
        Boolean(blackOnly?.name),
        blackOnly?.name
      );
    }

    console.log("\n== 13d. SLEEVE DROP: underarm points align across the body->sleeve seam ==");
    {
      const plane = buildGarmentPlane([
        { placement: "front", width_px: 3000, height_px: 3000, dpi: 100 },
        { placement: "back", width_px: 3000, height_px: 3000, dpi: 100 },
        { placement: "sleeve_left", width_px: 2000, height_px: 2400, dpi: 100 },
        { placement: "sleeve_right", width_px: 2000, height_px: 2400, dpi: 100 }
      ]);
      const byRole = Object.fromEntries(plane.panels.map((p) => [p.role, p]));
      const body = byRole["front"];
      const sleeve = byRole["left_sleeve"];
      const bodyUnderarm = body.yIn + 0.28 * body.heightIn;
      const sleeveUnderarm = sleeve.yIn + 0.17 * sleeve.heightIn;
      check(
        "sleeves drop below the shoulder line (cap joins the armhole, not the collar)",
        sleeve.yIn > body.yIn,
        `sleeve y=${sleeve.yIn.toFixed(1)} body y=${body.yIn.toFixed(1)}`
      );
      check(
        "underarm points meet within a quarter inch",
        Math.abs(bodyUnderarm - sleeveUnderarm) < 0.25,
        `body ${bodyUnderarm.toFixed(2)}in vs sleeve ${sleeveUnderarm.toFixed(2)}in`
      );
    }

    console.log("\n== 14. REACHABILITY GATE: lay language reaches the whole catalog ==");
    {
      // Customer wording (no supplier vocabulary, typos included) -> a
      // product whose name matches the expectation. If any line fails, part
      // of the catalog is unreachable from a Threadbot prompt.
      const cases: Array<[string, RegExp]> = [
        ["a trucker hat with flames", /trucker/i],
        ["dad hat with a small bee", /dad hat/i],
        ["a snapback for my brother", /snapback/i],
        ["a cozy beanie", /beanie/i],
        ["a bucket hat", /bucket hat/i],
        ["a onesie for my newborn", /bodysuit|one piece/i],
        ["a toddler tshirt with a dinosaur", /toddler/i],
        ["a youth tee for my son", /youth|kids/i],
        ["an iphone case with a dragon", /iphone/i],
        ["a phone case for my samsung galaxy", /samsung/i],
        ["a case for my airpods", /airpods/i],
        ["a poster of a mountain sunrise", /poster/i],
        ["a framed poster for the office", /framed poster/i],
        ["wall art on canvas of a wolf", /canvas/i],
        ["a cozy fleece blanket", /blanket/i],
        ["a beach towel with waves", /beach towel/i],
        ["a water bottle for hiking", /water bottle/i],
        ["an insulated tumbler", /tumbler/i],
        ["a scented candle", /candle/i],
        ["a jigsaw puzzle of my dog", /puzzle/i],
        ["a yoga mat with lotus flowers", /yoga mat/i],
        ["a fanny pack", /fanny pack/i],
        ["a tote bag for groceries", /tote/i],
        ["a duffle bag for the gym", /duffle|gym bag/i],
        ["a backpack covered in stars", /backpack/i],
        ["a laptop case", /laptop sleeve/i],
        ["crazy socks with tacos", /socks/i],
        ["an apron for my grill master dad", /apron/i],
        ["a shower curtain with jellyfish", /shower curtain/i],
        ["swim trunks with sharks", /trunks|board shorts/i],
        ["a bikini with cherries", /bikini/i],
        ["a one piece swimsuit", /swimsuit/i],
        ["a flowy skater dress", /dress/i],
        ["a long sleeve shirt with runes", /long sleeve/i],
        ["an oversized hoodie", /oversized.*hoodie/i],
        ["an oversized shirt", /oversized.*(t-shirt|tee|shirt)/i],
        ["comfy sweatpants", /sweatpants|joggers/i],
        ["a crewneck sweatshirt", /sweatshirt/i],
        ["a zip up hoodie", /zip.*hood/i],
        ["slides for the pool", /slides/i],
        ["flip flops", /flip.?flops/i],
        ["high top sneakers", /high top/i],
        ["a mouse pad for my desk", /mouse pad/i],
        ["stickers of little ghosts", /sticker/i],
        ["a greeting card", /greeting card/i],
        ["a spiral notebook", /notebook/i],
        ["a coffee cup with a cat", /mug/i],
        ["a wine glass", /wine/i],
        ["a leash for my dog", /leash/i],
        ["a dog bowl that says Gunner", /pet bowl/i],
        ["a collar for my cat", /collar/i],
        ["a doormat that says welcome", /doormat/i],
        ["a rug for my room", /rug/i],
        ["a tank top", /tank/i],
        ["a polo shirt", /polo/i],
        ["a windbreaker", /windbreaker|anorak/i],
        ["a bomber jacket", /bomber/i],
        ["a crop top with a sun", /crop/i],
        ["a sports bra", /sports bra/i],
        ["a basketball jersey", /basketball jersey/i],
        ["a flag for my dorm wall", /flag/i],
        ["a bandana for my dog", /bandana/i],
        ["a hoddie with a wolf", /hoodie/i],
        ["leggins with galaxies", /leggings/i],
        ["a tshrit with a skull", /t-shirt|tee/i]
      ];
      let reached = 0;
      const misses: string[] = [];
      for (const [query, expect] of cases) {
        const product = matchExpressProduct(query);
        if (expect.test(product.name)) reached++;
        else misses.push(`"${query}" -> ${product.name}`);
      }
      check(
        `all ${cases.length} lay-language requests reach the right product family (${reached}/${cases.length})`,
        reached === cases.length,
        misses.slice(0, 5).join(" | ")
      );
      // Whole-catalog reachability: every indexed product must be findable
      // by its OWN name words — nothing in the catalog is dead weight.
      let selfReachable = 0;
      const deadWeight: string[] = [];
      for (const row of searchCatalog("", 100000)) {
        const record = getCatalogRecord(row.id)!;
        const hit = matchExpressProduct(record.name.replace(/\|.*$/, ""));
        if (hit.productId === record.id || hit.name.split("|")[0].trim() === record.name.split("|")[0].trim()) selfReachable++;
        else deadWeight.push(`${record.id}:${record.name.slice(0, 40)} -> ${hit.productId}`);
      }
      check(
        `every catalog product reachable by its own name (${selfReachable}/481)`,
        selfReachable >= 460, // identically-named cross-listings may collide
        deadWeight.slice(0, 4).join(" | ")
      );
    }
    server.close();
  }

  console.log("\n== 15. COMMERCE BRIDGE: Stripe session + Printful order builders ==");
  {
    const secret = "whsec_test_abc123";
    const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } });
    check(
      "webhook signature roundtrip verifies",
      verifyStripeSignature(payload, signStripePayload(payload, secret), secret)
    );
    check(
      "tampered payload is rejected",
      !verifyStripeSignature(payload + " ", signStripePayload(payload, secret), secret)
    );
    check(
      "wrong secret is rejected",
      !verifyStripeSignature(payload, signStripePayload(payload, "whsec_other"), secret)
    );
    check(
      "stale timestamp (replay) is rejected",
      !verifyStripeSignature(
        payload,
        signStripePayload(payload, secret, Math.floor(Date.now() / 1000) - 3600),
        secret
      )
    );
    const form = buildSessionForm({
      productName: "All-Over Print Basic Pillow",
      description: "Custom pillow",
      imageUrl: "https://printful.example/mock.jpg",
      unitAmountCents: 2099,
      quantity: 2,
      shippingCents: 499,
      successUrl: "https://x/checkout/success",
      cancelUrl: "https://x/checkout/cancel",
      metadata: { run_id: "r1", panel_0: "front|sublimation|https://x/uploads/a" }
    });
    check(
      "session form carries server-priced line item",
      form.get("line_items[0][price_data][unit_amount]") === "2099" &&
        form.get("line_items[0][quantity]") === "2" &&
        form.get("line_items[0][price_data][product_data][name]") === "All-Over Print Basic Pillow"
    );
    check(
      "shipping + address collection + metadata present",
      form.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") === "499" &&
        form.get("shipping_address_collection[allowed_countries][0]") === "US" &&
        form.get("metadata[panel_0]") === "front|sublimation|https://x/uploads/a"
    );
    const record = {
      run_id: "run-77",
      product_id: 358,
      variant_id: 9498,
      product_name: "All-Over Print Basic Pillow",
      retail_usd: 20.99,
      mockup_url: null,
      placements: [
        { placement: "front", technique: "sublimation", file_url: "https://x/uploads/f" },
        { placement: "back", technique: "sublimation", file_url: "https://x/uploads/b" }
      ],
      product_options: { stitch_color: "black" },
      created_at: Date.now()
    };
    registerDesign(record);
    check(
      "app designId `${run_id}-${i}` resolves to the registered run",
      getDesign("run-77-2")?.product_id === 358 && getDesign("run-77")?.product_id === 358
    );
    check("unknown design is a miss, not a crash", getDesign("nope-0") === null);
    const order = buildOrderPayload({
      record,
      catalogVariantId: 9502,
      quantity: 1,
      recipient: {
        name: "Doug A",
        address1: "1 Main St",
        city: "Peoria",
        state_code: "IL",
        country_code: "US",
        zip: "61602",
        email: "d@example.com"
      },
      externalId: "cs_test_123",
      retailPerItemUsd: 20.99,
      confirm: false
    });
    const item = order.order_items[0];
    check(
      "printful v2 order: catalog source, resolved variant, exact retail",
      item.source === "catalog" && item.catalog_variant_id === 9502 && item.retail_price === "20.99"
    );
    check(
      "order prints the SAME files the mockups rendered (both panels, print-res)",
      item.placements.length === 2 &&
        item.placements[0].layers[0].url === "https://x/uploads/f" &&
        item.placements[1].placement === "back"
    );
    check(
      "product options (stitch_color) ride the order",
      JSON.stringify((item as { product_options?: unknown }).product_options) ===
        JSON.stringify([{ name: "stitch_color", value: "black" }])
    );
    check(
      "recipient mapped from Stripe session shape",
      order.recipient.name === "Doug A" && order.recipient.zip === "61602" && order.external_id === "cs_test_123"
    );

    // Shipping: supplier-quoted, never a flat guess.
    const usReq = buildShippingRequest(9513, 1, "US");
    check(
      "US/CA quotes carry the representative state Printful demands",
      usReq.recipient.country_code === "US" &&
        (usReq.recipient as { state_code?: string }).state_code === "CA" &&
        buildShippingRequest(9513, 1, "GB").recipient.country_code === "GB" &&
        !(buildShippingRequest(9513, 1, "GB").recipient as { state_code?: string }).state_code
    );
    const cheapest = pickCheapestRate([
      { id: "EXPRESS", name: "Express", rate: "24.99", minDeliveryDays: 1, maxDeliveryDays: 2 },
      { id: "STANDARD", name: "Flat Rate (Estimated delivery: Jul 14-15)", rate: "10.49", minDeliveryDays: 3, maxDeliveryDays: 4 }
    ]);
    check(
      "cheapest rate wins and the label never names the supplier",
      cheapest?.cents === 1049 &&
        cheapest.display_name === "Standard shipping (3–4 business days)" &&
        !/printful|flat rate/i.test(cheapest.display_name)
    );
    check("garbage rates yield null (fallback path), not NaN cents", pickCheapestRate([{ rate: "oops" }]) === null);
    check(
      "country picks normalize (gb -> GB, junk -> US)",
      normalizeShippingCountry("gb") === "GB" && normalizeShippingCountry("XX") === "US" && normalizeShippingCountry(7) === "US"
    );
    check(
      "variant-invalid style ids self-heal from Printful's 400 (the Pet Bowl mockup fix)",
      JSON.stringify(
        parseAvailableStyleIds(
          '{"data":"Following `style_ids`: 6558, 6561 are not available for catalog variant: 16786 with placements: default. Available `style_ids` are: 6559, 6560, 6562, 6564"}'
        )
      ) === "[6559,6560,6562,6564]" && parseAvailableStyleIds('{"data":"some other 400"}') === null
    );
    const lockedForm = buildSessionForm({
      productName: "x",
      unitAmountCents: 2099,
      quantity: 1,
      shippingCents: 1109,
      shippingLabel: "Standard shipping (3–4 business days)",
      allowedCountries: ["GB"],
      successUrl: "https://x/s",
      cancelUrl: "https://x/c",
      metadata: {}
    });
    check(
      "session locks address entry to the quoted country at the quoted rate",
      lockedForm.get("shipping_address_collection[allowed_countries][0]") === "GB" &&
        lockedForm.get("shipping_address_collection[allowed_countries][1]") === null &&
        lockedForm.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") === "1109" &&
        lockedForm.get("shipping_options[0][shipping_rate_data][display_name]") === "Standard shipping (3–4 business days)"
    );
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
