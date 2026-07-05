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
import { buildExpressMedia } from "./media.js";
import { buildExpressJobs, pickPrimaryPlacement, pickStitchColor } from "./plan.js";
import { PrintfulTruth, ProductTruth } from "./truth.js";
import { buildVerbatimPanel } from "./verbatim.js";

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
  /**
   * Compatibility aliases for clients built against the agent pipeline's
   * Final Response Composer shape (the original Threadbot APK UI). Express
   * results carry the same keys that UI already reads, so it renders
   * express runs without modification.
   */
  user_message: string;
  mockup_urls: string[];
  mockup_url: string | null;
  design_summary: string;
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
  if (!sharedTruth) sharedTruth = new PrintfulTruth();
  return {
    provider: getLlmProvider(),
    // FLUX.2 flex first, OpenAI safety net; fresh instance per run so the
    // sticky engine fallback resets between runs.
    media: await buildExpressMedia(),
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
  user_message: "",
  mockup_urls: [],
  mockup_url: null,
  design_summary: "",
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

/** Keep the legacy-shape aliases in lockstep with the express fields. */
const syncLegacyAliases = (result: ExpressResult) => {
  result.user_message = result.message;
  result.mockup_urls = result.mockups.map((mockup) => mockup.mockup_url);
  result.mockup_url = result.mockup_urls[0] ?? null;
  if (!result.design_summary && result.intent) {
    result.design_summary = result.intent.artwork_brief.slice(0, 300);
  }
};

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
  syncLegacyAliases(result);
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
    finishEconomics(result, meter, llmCalls);
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

  // 4. Deterministic product choice (explicit picker id wins). Lay all-over
  // language ("covered in...", "everywhere") upgrades to AOP products.
  const preferAop = intent.all_over || intent.wants_repeat_pattern;
  const product =
    (input.product_id ? getExpressProduct(input.product_id) : undefined) ??
    (intent.product_query || text
      ? matchExpressProduct(`${intent.product_query} ${text}`, { preferAop })
      : getExpressProduct(DEFAULT_PRODUCT_ID)!);

  const result = baseResult(runId, product);
  result.intent = intent;
  result.degraded_intent = degraded;
  result.coverage = product.aop ? intent.coverage : "single";

  // 4b. Image directives: verbatim images bypass generation entirely; the
  // rest guide it (edits, style, elements) via references + brief notes.
  const plan = intent.image_plan.filter(
    (entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index < imageUrls.length
  );
  const verbatimEntry = plan.find(
    (entry) => entry.role === "use_verbatim" || entry.role === "verbatim_remove_background"
  );
  const referenceUrls = imageUrls.filter(
    (_, i) =>
      !plan.some(
        (entry) =>
          entry.index === i &&
          (entry.role === "use_verbatim" || entry.role === "verbatim_remove_background")
      )
  );
  const planNotes = plan
    .filter((entry) => entry.role !== "use_verbatim" && entry.role !== "verbatim_remove_background")
    .map((entry) => `Reference image ${entry.index + 1}: ${entry.instruction.slice(0, 200)}`)
    .join(". ");

  try {
    // 5. Product truth (free, cached) BEFORE any paid image work.
    // Variant: stated color/size preferences win (one free cached read);
    // otherwise the committed index default.
    const variantHints = [intent.garment_color, intent.size_preference]
      .filter(Boolean)
      .join(" ")
      .trim();
    const [specs, variantId, optionNames] = await Promise.all([
      resolved.truth.placementSpecs(product.productId),
      input.variant_id
        ? Promise.resolve(input.variant_id)
        : // Only a CUSTOMER preference justifies a live variant lookup; the
          // committed index default already prefers white/medium.
          resolved.truth.resolveVariant(product.productId, variantHints || undefined),
      resolved.truth.productOptionNames(product.productId)
    ]);
    result.product.variant_id = variantId;

    const metered = meteredMedia(resolved.media, meter);
    const brief = [intent.image_prompt || intent.artwork_brief || text, planNotes]
      .filter(Boolean)
      .join(". ");
    let activeSpecs;

    if (verbatimEntry) {
      // 6a. VERBATIM: the uploaded image IS the artwork — zero generations,
      // pixel-faithful placement on the primary print area.
      const renderable = specs.filter((spec) => !/label/i.test(spec.placement));
      const primary = pickPrimaryPlacement(renderable);
      activeSpecs = [primary];
      result.coverage = "single";
      result.strategy = "direct";
      const { panel, provenance } = await buildVerbatimPanel(
        metered,
        primary,
        imageUrls[verbatimEntry.index],
        verbatimEntry.role === "verbatim_remove_background"
      );
      result.panels = [panel];
      result.design_genome = {
        version: "threadbot-genome/1",
        run_id: runId,
        strategy: "direct",
        master_artwork_url: null,
        pattern_tile_url: null,
        panels: [provenance]
      };
    } else {
      // 6b. Deterministic surface plan + panel compilation (one master).
      const built = buildExpressJobs(product, specs, intent);
      activeSpecs = built.activeSpecs;
      const design: DesignSpec = {
        artwork_brief: brief,
        style_terms: intent.style_terms,
        palette: intent.palette,
        mood_terms: intent.mood_terms,
        required_text: intent.required_text,
        forbidden_text: intent.forbidden_text,
        base_product_color: intent.garment_color || undefined,
        customer_image_urls: referenceUrls,
        customer_image_captions: captions
      };
      const compiler = new PanelCompiler(metered);
      const compiled = await compiler.compile(
        runId,
        built.jobs,
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
    }

    const techniqueByPlacement = new Map(activeSpecs.map((spec) => [spec.placement, spec.technique]));
    result.submitted_placements = result.panels
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
      widthPx: 1000,
      // Multi-placement AOP tasks render slowly; proven live: a 6-panel
      // hoodie needs >150s. Patience is free — regeneration is not.
      maxAttempts: 80,
      intervalSeconds: 5
    });

    if (rendered.status === "completed" && rendered.mockups.length) {
      result.mockups = rendered.mockups;
      result.status = "completed";
      result.message =
        `Your ${product.name} design is ready — ${result.submitted_placements.length} print ` +
        `panel(s) generated and rendered on official product mockups.`;
    } else {
      result.status = "mockup_failed";
      const reasons = JSON.stringify(
        (rendered.raw as { failure_reasons?: unknown[] } | null)?.failure_reasons ?? rendered.status
      ).slice(0, 400);
      console.error(`[express] mockup task did not complete: ${reasons}`);
      result.message =
        "Your print files were generated, but the product preview service didn't return mockups. " +
        "The design is saved; previews can be retried without regenerating artwork.";
      result.missing_required_placements = [
        ...result.missing_required_placements,
        { placement: "mockup", reason: reasons }
      ];
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
