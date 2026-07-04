/**
 * Threadbot EXPRESS run — the default, unit-economics-first product path.
 *
 * Per-run paid work is capped by construction:
 *   - 1 structured light-LLM call (intent + policy)        ~ $0.002
 *   - 1 light vision caption per attached image (<=10)     ~ $0.002 each
 *   - 1 master image generation (+ per-panel upscales)     ~ $0.03-0.05
 *   - Printful mockups + catalog reads                     $0
 *   - customer message: template                           $0
 *
 * Everything else — product match, surface plan, panel slicing, seam
 * continuity, stitch color, coverage accounting — is deterministic code
 * reusing the pixel-proven Panel Compiler and calibration data. The
 * 13-agent pipeline (runWorkflow) is preserved unchanged as the premium /
 * fallback mode; its frozen instructions and schemas are not touched.
 *
 * Every run reports its own economics (calls, images, estimated cost, margin
 * anchors) so cost regressions are visible per run, not per invoice.
 */

import { randomUUID } from "node:crypto";
import { PanelCompiler, CompiledPanel, DesignSpec, MediaLike } from "../engine/panelCompiler.js";
import { getCalibrationProfile } from "../engine/calibrationProfiles.js";
import { DesignGenome } from "../engine/provenance.js";
import {
  createAndWaitForMockups,
  MockupPlacementFile,
  MockupRender
} from "../integrations/printfulMockups.js";
import { getLlmProvider, LlmProvider } from "../llm/provider.js";
import { normalizeCustomerImages } from "../workflow.js";
import { DEFAULT_PRODUCT_ID, ExpressProduct, getExpressProduct, matchExpressProduct } from "./catalog.js";
import { deriveIntent, ExpressIntent, screenRequest } from "./intent.js";
import { buildExpressJobs, pickPrimaryPlacement, pickStitchColor } from "./plan.js";
import { PrintfulTruth, ProductTruth } from "./truth.js";

export interface ExpressInput {
  input_as_text: string;
  input_image_urls?: string[];
  /** Explicit product/variant from the app's picker — skips keyword matching. */
  product_id?: number;
  variant_id?: number;
}

export interface ExpressEconomics {
  llm_calls: number;
  image_generations: number;
  upscales: number;
  estimated_ai_cost_usd: number;
  base_cost_anchor_usd: number;
  retail_anchor_usd: number;
  estimated_margin_anchor_usd: number;
}

export interface ExpressResult {
  mode: "express";
  run_id: string;
  status: "completed" | "refused" | "failed" | "mockup_failed";
  message: string;
  product: { id: number; name: string; variant_id: number | null };
  coverage: "full" | "single";
  strategy: string | null;
  intent: ExpressIntent | null;
  degraded_intent: boolean;
  panels: CompiledPanel[];
  submitted_placements: Array<MockupPlacementFile & { file_url: string }>;
  mockups: MockupRender[];
  design_genome: DesignGenome | null;
  missing_required_placements: Array<{ placement: string; reason: string }>;
  economics: ExpressEconomics;
}

export interface ExpressDeps {
  provider: LlmProvider;
  media: MediaLike;
  truth: ProductTruth;
  renderMockups: typeof createAndWaitForMockups;
}

let sharedTruth: PrintfulTruth | null = null;

const defaultDeps = async (): Promise<ExpressDeps> => {
  const { RunwareMedia } = await import("../runware/media.js");
  if (!sharedTruth) sharedTruth = new PrintfulTruth();
  return {
    provider: getLlmProvider(),
    media: new RunwareMedia(),
    truth: sharedTruth,
    renderMockups: createAndWaitForMockups
  };
};

/** Per-image/LLM cost anchors (USD) for the estimated_ai_cost_usd telemetry. */
const COST_PER_GENERATION = 0.03;
const COST_PER_UPSCALE = 0.002;
const COST_PER_LLM_CALL = 0.003;

/** Wrap media so every paid call is counted into the run's economics. */
const meteredMedia = (media: MediaLike, meter: { generations: number; upscales: number }): MediaLike => ({
  generateImage: (params) => {
    meter.generations += 1;
    return media.generateImage(params);
  },
  removeBackground: (url) => media.removeBackground(url),
  upscale: (image, factor) => {
    meter.upscales += 1;
    return media.upscale(image, factor);
  },
  uploadImage: (image) => media.uploadImage(image)
});

const baseResult = (runId: string, product: ExpressProduct | null): ExpressResult => ({
  mode: "express",
  run_id: runId,
  status: "failed",
  message: "",
  product: {
    id: product?.productId ?? 0,
    name: product?.name ?? "",
    variant_id: null
  },
  coverage: "full",
  strategy: null,
  intent: null,
  degraded_intent: false,
  panels: [],
  submitted_placements: [],
  mockups: [],
  design_genome: null,
  missing_required_placements: [],
  economics: {
    llm_calls: 0,
    image_generations: 0,
    upscales: 0,
    estimated_ai_cost_usd: 0,
    base_cost_anchor_usd: product?.baseCostUsd ?? 0,
    retail_anchor_usd: product?.retailUsd ?? 0,
    estimated_margin_anchor_usd: 0
  }
});

const finishEconomics = (result: ExpressResult, meter: { generations: number; upscales: number }, llmCalls: number) => {
  const aiCost =
    meter.generations * COST_PER_GENERATION +
    meter.upscales * COST_PER_UPSCALE +
    llmCalls * COST_PER_LLM_CALL;
  result.economics.llm_calls = llmCalls;
  result.economics.image_generations = meter.generations;
  result.economics.upscales = meter.upscales;
  result.economics.estimated_ai_cost_usd = Number(aiCost.toFixed(4));
  result.economics.estimated_margin_anchor_usd = Number(
    (result.economics.retail_anchor_usd - result.economics.base_cost_anchor_usd - aiCost).toFixed(2)
  );
};

export const runExpress = async (
  input: ExpressInput,
  deps?: ExpressDeps
): Promise<ExpressResult> => {
  const runId = randomUUID();
  const resolved = deps ?? (await defaultDeps());
  const meter = { generations: 0, upscales: 0 };
  let llmCalls = 0;

  const text = (input.input_as_text ?? "").trim();

  // 1. $0 policy pre-gate — refuse before any paid call.
  const screened = screenRequest(text);
  if (screened.blocked) {
    const result = baseResult(runId, null);
    result.status = "refused";
    result.message = screened.reason;
    return result;
  }

  // 2. Reference images -> captions (light vision, one per image).
  const { accepted: imageUrls } = normalizeCustomerImages(input.input_image_urls);
  let captions: string[] = [];
  if (imageUrls.length) {
    captions = await Promise.all(
      imageUrls.map((url) =>
        resolved.provider
          .captionImage(url)
          .then((caption) => {
            llmCalls += 1;
            return caption;
          })
          .catch(() => "")
      )
    );
    captions = captions.filter(Boolean);
  }

  // 3. The one planning judgment: intent + policy in a single light call.
  const { intent, degraded } = await deriveIntent(resolved.provider, text, captions);
  if (!degraded) llmCalls += 1;
  if (!intent.allowed) {
    const result = baseResult(runId, null);
    result.status = "refused";
    result.intent = intent;
    result.message =
      intent.refusal_reason ??
      "This request can't be printed. Please describe an original design instead.";
    finishEconomics(result, meter, llmCalls);
    return result;
  }

  // 4. Deterministic product choice (explicit picker id wins).
  const product =
    (input.product_id ? getExpressProduct(input.product_id) : undefined) ??
    (intent.product_query || text
      ? matchExpressProduct(`${intent.product_query} ${text}`)
      : getExpressProduct(DEFAULT_PRODUCT_ID)!);

  const result = baseResult(runId, product);
  result.intent = intent;
  result.degraded_intent = degraded;
  result.coverage = product.aop ? intent.coverage : "single";

  try {
    // 5. Product truth (free, cached) BEFORE any paid image work.
    const [specs, variantId, optionNames] = await Promise.all([
      resolved.truth.placementSpecs(product.productId),
      input.variant_id
        ? Promise.resolve(input.variant_id)
        : resolved.truth.resolveVariant(product.productId, product.variantPick),
      resolved.truth.productOptionNames(product.productId)
    ]);
    result.product.variant_id = variantId;

    // 6. Deterministic surface plan + panel compilation (one master image).
    const { jobs, activeSpecs } = buildExpressJobs(product, specs, intent);
    const design: DesignSpec = {
      artwork_brief: intent.artwork_brief || text,
      style_terms: intent.style_terms,
      palette: intent.palette,
      mood_terms: intent.mood_terms,
      required_text: intent.required_text,
      forbidden_text: intent.forbidden_text,
      customer_image_urls: imageUrls,
      customer_image_captions: captions
    };
    const compiler = new PanelCompiler(meteredMedia(resolved.media, meter));
    const compiled = await compiler.compile(
      runId,
      jobs,
      design,
      getCalibrationProfile(product.productId)
    );
    result.strategy = compiled.strategy;
    result.panels = compiled.panels;
    result.design_genome = compiled.genome;
    result.missing_required_placements = compiled.missing_required_placements;

    if (!compiled.all_required_succeeded) {
      result.status = "failed";
      result.message =
        "We couldn't finish generating every print panel for this design. Nothing was rendered; please try again.";
      finishEconomics(result, meter, llmCalls);
      return result;
    }

    const techniqueByPlacement = new Map(activeSpecs.map((spec) => [spec.placement, spec.technique]));
    result.submitted_placements = compiled.panels
      .filter((panel) => panel.status === "success" && panel.file_url && panel.must_render_in_mockup)
      .map((panel) => ({
        placement: panel.placement,
        technique: techniqueByPlacement.get(panel.placement) ?? "dtg",
        fileUrl: panel.file_url as string,
        file_url: panel.file_url as string
      }));

    // 7. Official Printful mockups — the hard-coded final-output rule.
    const styleIds = pickPrimaryPlacement(activeSpecs).styleIds.slice(0, 2);
    const productOptions = optionNames.includes("stitch_color")
      ? { stitch_color: pickStitchColor(intent) }
      : undefined;
    const rendered = await resolved.renderMockups({
      productId: product.productId,
      variantIds: [variantId],
      placements: result.submitted_placements.map(({ placement, technique, fileUrl }) => ({
        placement,
        technique,
        fileUrl
      })),
      styleIds,
      productOptions,
      format: "jpg",
      widthPx: 1000
    });

    if (rendered.status === "completed" && rendered.mockups.length) {
      result.mockups = rendered.mockups;
      result.status = "completed";
      result.message =
        `Your ${product.name} design is ready — ${result.submitted_placements.length} print ` +
        `panel(s) generated and rendered on official product mockups.`;
    } else {
      result.status = "mockup_failed";
      result.message =
        "Your print files were generated, but the product preview service didn't return mockups. " +
        "The design is saved; previews can be retried without regenerating artwork.";
    }
  } catch (error) {
    result.status = "failed";
    result.message = "Something went wrong preparing this design. Please try again.";
    result.missing_required_placements = [
      ...result.missing_required_placements,
      { placement: "run", reason: (error as Error).message.slice(0, 500) }
    ];
  }

  finishEconomics(result, meter, llmCalls);
  return result;
};
