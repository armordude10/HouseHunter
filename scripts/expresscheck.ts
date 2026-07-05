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
import {
  catalogSize,
  getCatalogRecord,
  getExpressProduct,
  matchExpressProduct,
  searchCatalog
} from "../src/express/catalog.js";
import { ExpressIntent, heuristicIntent, screenRequest } from "../src/express/intent.js";
import { buildExpressJobs, pickStitchColor } from "../src/express/plan.js";
import { runExpress, ExpressDeps } from "../src/express/run.js";
import { PlacementSpec, PrintfulTruth, ProductTruth } from "../src/express/truth.js";
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
  removeBackgroundCalls = 0;
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
    if (productId === 71) return TEE_SPECS;
    if (productId === 257) return AOP_TEE_SPECS;
    if (productId === 19) return MUG_SPECS;
    throw new Error(`stub truth has no product ${productId}`);
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
      check("color+size preference reaches variant resolution", truth.lastPick === "black XL", String(truth.lastPick));
    }
    {
      check(
        "lay all-over language upgrades tee to AOP sibling (257)",
        matchExpressProduct("a shirt covered in koi fish everywhere", { preferAop: true }).productId === 257
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
        check("code-rendered text costs ZERO generations", media.generateCalls === 0);
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
        check("two layers, zero generations", media.generateCalls === 0 && result.panels.length === 1);
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
              { ...layerBase, kind: "text" as const, content: "745", cx_frac: 0.5, cy_frac: 0.22, width_frac: 0.6, color: "#00ff88" }
            ]
          })
        );
        const result = await runExpress(
          { input_as_text: "an AOP grungy rap metal themed shirt that says 745 in grungy text across the chest" },
          deps
        );
        check("745 run completed", result.status === "completed", result.message);
        check("AOP product selected (257), not the plain tee", result.product.id === 257);
        check("full multi-panel artwork (master_slice, 4 panels)", result.strategy === "master_slice" && result.panels.length === 4, `${result.strategy}/${result.panels.length}`);
        check("one master generation only", media.generateCalls === 1);
        const front = result.panels.find((p) => p.placement === "front")!;
        check("front panel carries the layered overlay", /Layered overlay applied/.test(front.notes), front.notes.slice(0, 80));
        check("all 4 panels submitted to mockups", mockups.calls[0]?.placements.length === 4);
        // Pixel proof: count PURE-GREEN text pixels (#00ff88-ish) per band —
        // the stub's art gradient never produces r<40 && g>240 pixels, so any
        // hits are the code-rendered '745' ink itself.
        const buffer = Buffer.from((front.file_url as string).split(",")[1], "base64");
        const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
        const inkIn = (fromFrac: number, toFrac: number) => {
          let hits = 0;
          const y0 = Math.round(info.height * fromFrac);
          const y1 = Math.round(info.height * toFrac);
          for (let y = y0; y < y1; y++) {
            for (let x = 0; x < info.width; x++) {
              const i = (y * info.width + x) * info.channels;
              if (data[i] < 40 && data[i + 1] > 240) hits++;
            }
          }
          return hits;
        };
        const chest = inkIn(0.1, 0.35);
        const hem = inkIn(0.6, 0.95);
        check(
          "745 ink grounded at the chest ON TOP of the art (pure-green pixels in chest band only)",
          chest > 100 && hem === 0,
          `chest ${chest} px vs hem ${hem} px`
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
          "raw-text 'AOP' backstops the model (intent said all_over=false, still 257)",
          result.product.id === 257
        );
      }
      check(
        "heuristic reads bare 'AOP'",
        heuristicIntent("an AOP grungy rap metal themed shirt").all_over === true
      );
    }
    server.close();
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
