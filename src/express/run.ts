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
import { hostedImageUrl, putHostedImage, waitForDurablePersists } from "../hosting.js";
import {
  DEFAULT_PRODUCT_ID,
  ExpressProduct,
  getCatalogRecord,
  getExpressProduct,
  matchExpressProduct
} from "./catalog.js";
import { deriveIntent, DesignLayer, ExpressIntent, screenRequest } from "./intent.js";
import sharp from "sharp";
import { compileLayeredPanel, MAX_LAYERS, renderLayerOverlay } from "./layers.js";
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
  /** Per-stage wall times — the diagnosis for any slow run rides the response. */
  stage_ms?: { intent?: number; panels?: number; mockups?: number };
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
  /** Required product options (e.g. stitch_color) — reused verbatim by orders. */
  product_options?: Record<string, string>;
  mockups: MockupRender[];
  design_genome: DesignGenome | null;
  missing_required_placements: Array<{ placement: string; reason: string }>;
  economics: ExpressEconomics;
  /** Front-to-back decision log: every judgment, prompt, and outcome. */
  trace: Array<{ ms: number; stage: string; info: string }>;
}

export interface ExpressDeps {
  provider: LlmProvider;
  media: MediaLike;
  truth: ProductTruth;
  renderMockups: typeof createAndWaitForMockups;
  /** Hosting hook for locally-composed pixels (layer engine output). */
  hostImage?: (bytes: Buffer, contentType?: string) => Promise<string>;
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
  uploadImage: (image) => media.uploadImage(image),
  // CRITICAL passthrough: dropping hostImage silently disabled the <=2048px
  // mockup copies — every multi-panel mockup task got print-res files
  // (6x ~2.8MB) and blew Printful's render window. THE AOP-hoodie timeout.
  ...(media.hostImage ? { hostImage: media.hostImage.bind(media) } : {})
});

const fetchPanelBytes = async (url: string): Promise<Buffer> => {
  if (url.startsWith("data:")) return Buffer.from(url.replace(/^data:[^,]*,/, ""), "base64");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`panel fetch failed (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};

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
  trace: [],
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
  const tRun = Date.now();
  const trace: Array<{ ms: number; stage: string; info: string }> = [];
  const note = (stage: string, info: unknown) =>
    trace.push({ ms: Date.now() - tRun, stage, info: String(info).slice(0, 2000) });
  note("input", text);

  // 1. $0 policy pre-gate — refuse before any paid call.
  const screened = screenRequest(text);
  if (screened.blocked) {
    const result = baseResult(runId, null);
    result.trace = trace;
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
  const stageMs: { intent?: number; panels?: number; mockups?: number } = {};
  const tIntent = Date.now();
  const { intent, degraded } = await deriveIntent(resolved.provider, text, captions);
  stageMs.intent = Date.now() - tIntent;
  if (!degraded) llmCalls += 1;
  note("intent" + (degraded ? " (DEGRADED heuristic)" : ""), JSON.stringify(intent));
  if (!intent.allowed) {
    const result = baseResult(runId, null);
    result.trace = trace;
    result.status = "refused";
    result.intent = intent;
    result.message =
      intent.refusal_reason ??
      "This request can't be printed. Please describe an original design instead.";
    finishEconomics(result, meter, llmCalls);
    return result;
  }

  // 4. Deterministic product choice (explicit picker id wins). Lay all-over
  // language ("covered in...", "everywhere") upgrades to AOP products; the
  // raw-text check backstops the model in case it misses industry terms.
  const preferAop =
    intent.all_over ||
    intent.wants_repeat_pattern ||
    /\baop\b|\ball[- ]?over\b|\bsublimation\b/i.test(text);
  // EXPLICIT-NOUN GUARD: the customer's own words outrank the model's
  // product_query. If the raw text names a product family (its match shares
  // a name word with the text) and the combined match does NOT, the model
  // was steered (live incident: taste history turned "dark blue shirt with
  // this logo" into a sports bra) — trust the words.
  const nameNamedInText = (name: string, rawText: string): boolean => {
    const low = ` ${rawText.toLowerCase()} `;
    return name
      .split("|")[0]
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !["all", "over", "print", "the", "unisex", "recycled"].includes(w))
      .some((w) => low.includes(` ${w}`) || low.includes(`${w.slice(0, -1)}s `));
  };
  const chooseProduct = () => {
    if (!intent.product_query && !text) return getExpressProduct(DEFAULT_PRODUCT_ID)!;
    const combined = matchExpressProduct(`${intent.product_query} ${text}`, { preferAop });
    if (!intent.product_query) return combined;
    const rawOnly = matchExpressProduct(text, { preferAop });
    if (
      rawOnly.productId !== combined.productId &&
      nameNamedInText(rawOnly.name, text) &&
      !nameNamedInText(combined.name, text)
    ) {
      note("product_guard", `explicit noun override: ${combined.name} -> ${rawOnly.name}`);
      return rawOnly;
    }
    return combined;
  };
  const product =
    (input.product_id ? getExpressProduct(input.product_id) : undefined) ?? chooseProduct();

  const result = baseResult(runId, product);
  result.trace = trace;
  note("product", `#${product.productId} ${product.name} (aop=${product.aop}, preferAop=${preferAop})`);
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
    // COLOR SEMANTICS: on printed-surface products (AOP / sublimation) the
    // requested color IS the artwork's base — bases only come white, so
    // "red sports bra" means red art edge-to-edge, not a red variant (live
    // incident: red bra came back white). On fabric-color products (DTG)
    // the color picks the variant, as before.
    const record = getCatalogRecord(product.productId);
    // Printed-surface techniques: the print IS the product's visible surface
    // (dtg/dtfilm/embroidery decorate a colored fabric instead).
    const printedSurface =
      product.aop ||
      Boolean(
        record?.placements?.some(
          (p) =>
            !/label/i.test(p.placement) &&
            /sublimation|cut-sew|digital|^uv$|direct-to-fabric/.test(p.technique)
        )
      );
    // The intent model often leaves garment_color empty for non-garments
    // ("laptop sleeve that is dark blue" — live incident), so the stated
    // base color is ALSO extracted from the raw words: either "that is /
    // in / make it <color>", or a color immediately before a product-name
    // word ("red sports bra"). Subject colors ("golden lion") don't match.
    const COLOR_WORD =
      "(?:(?:dark|light|deep|bright|royal|hot|navy|forest|sky|baby|blood|matte)\\s+)?" +
      "(?:black|white|red|blue|green|yellow|orange|purple|violet|pink|brown|tan|beige|cream|gray|grey|teal|cyan|turquoise|navy|maroon|burgundy|crimson|gold|silver|charcoal)";
    const extractStatedBaseColor = (): string => {
      if (intent.garment_color) return intent.garment_color;
      const low = text.toLowerCase();
      // NOTE: no bare "in <color>" pattern — "says sugar baby in yellow"
      // names the TEXT color, not the base.
      const phrased = low.match(
        new RegExp(`(?:that is|that's|which is|make it|colou?red)\\s+(${COLOR_WORD})\\b`)
      );
      if (phrased) return phrased[1];
      const nameWords = new Set(
        product.name.split("|")[0].toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3)
      );
      const adjacent = [...low.matchAll(new RegExp(`\\b(${COLOR_WORD})\\s+([a-z]+)`, "g"))];
      for (const m of adjacent) {
        if (nameWords.has(m[2])) return m[1];
      }
      return "";
    };
    const statedBaseColor = printedSurface ? extractStatedBaseColor() : intent.garment_color;
    note("surface", `printedSurface=${printedSurface} statedBaseColor="${statedBaseColor}" garment_color="${intent.garment_color}"`);

    // 5. Product truth (free, cached) BEFORE any paid image work.
    // Variant: stated color/size preferences win (one free cached read);
    // otherwise the committed index default.
    const variantHints = [
      intent.variant_hint,
      printedSurface ? "" : intent.garment_color,
      intent.size_preference
    ]
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
    note("variant", `hints="${variantHints}" -> variant ${variantId}; options=${JSON.stringify(optionNames)}`);

    const rawMetered = meteredMedia(resolved.media, meter);
    const metered: MediaLike = {
      ...rawMetered,
      generateImage: (params) => {
        note("generate_prompt", (params as { positivePrompt?: string }).positivePrompt ?? "");
        return rawMetered.generateImage(params);
      }
    };
    const surfaceColorDirective =
      printedSurface && statedBaseColor
        ? `. The design's base color is ${statedBaseColor.slice(0, 30)}: it fills the entire printable surface edge to edge — the printed art IS the product's color, no white background anywhere.`
        : "";
    const brief =
      [intent.image_prompt || intent.artwork_brief || text, planNotes].filter(Boolean).join(". ") +
      surfaceColorDirective;
    note("brief", brief);
    let activeSpecs;

    // Shared layer plumbing (standalone and overlay modes).
    const renderableSpecs = specs.filter((spec) => !/label/i.test(spec.placement));
    const layerProfile = getCalibrationProfile(product.productId);
    const hostImage =
      resolved.hostImage ??
      (async (bytes: Buffer, contentType = "image/png") =>
        hostedImageUrl(putHostedImage(bytes, contentType)));

    // TYPOGRAPHY POLICY: text is ALWAYS generated (gpt-image-class lockups),
    // never code-rendered — flat SVG type is retired. Any "text" layer the
    // intent emits becomes a generated-typography element.
    const typographyPrompt = (content: string, color: string) =>
      `the exact text "${content.slice(0, 80)}" as expressive hand-crafted ` +
      `${(intent.style_terms.concat(intent.mood_terms).slice(0, 4).join(" ") || "artful").slice(0, 70)} lettering, ` +
      `${color ? `${color.slice(0, 24)} lettering, ` : ""}single isolated text lockup that matches the artwork's aesthetic, ` +
      `perfect spelling, never a plain default font`;
    const convertedTexts = new Map<DesignLayer, string>();
    const effectiveLayers: DesignLayer[] = intent.layers.slice(0, MAX_LAYERS).map((layer) => {
      if (layer.kind !== "text") return layer;
      const converted = {
        ...layer,
        kind: "element" as const,
        content: typographyPrompt(layer.content, layer.color)
      };
      convertedTexts.set(converted, layer.content);
      return converted;
    });

    // ANTI-DUPLICATION: text carried by a layer must not ALSO ride the
    // master/panel prompts (the double-print bug). Strip covered strings.
    const layerText = new Set(
      intent.layers.filter((l) => l.kind === "text").map((l) => l.content.toLowerCase().trim())
    );
    let requiredText = intent.required_text.filter((t) => {
      const low = t.toLowerCase().trim();
      if (layerText.has(low)) return false;
      return !effectiveLayers.some((l) => l.content.toLowerCase().includes(`"${low}"`));
    });

    // ANTI-DOUBLE-PRINT, second door: the intent's image_prompt is written
    // "faithful to the customer's words" and often carries `says "X"` — if a
    // lockup layer carries X, the master must not paint it too. Scrub the
    // string AND its framing verb from every generation brief.
    const scrubTextFromBrief = (brief: string, texts: string[]): string => {
      let out = brief;
      for (const t of texts) {
        if (!t.trim()) continue;
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(
          new RegExp(
            `(that says|which says|saying|says|that said|with the (words|text|phrase)|reading)?\\s*[\"'\u201c\u2018]?${escaped}[\"'\u201d\u2019]?`,
            "gi"
          ),
          ""
        );
      }
      return out.replace(/\s{2,}/g, " ").trim();
    };

    const groupLayers = (layers: DesignLayer[]) => {
      const grouped = new Map<string, DesignLayer[]>();
      for (const layer of layers.slice(0, MAX_LAYERS)) {
        const spec =
          renderableSpecs.find((s) => s.placement === layer.placement) ??
          pickPrimaryPlacement(renderableSpecs);
        const list = grouped.get(spec.placement);
        if (list) list.push(layer);
        else grouped.set(spec.placement, [layer]);
      }
      return grouped;
    };

    // TEXT POLICY (the Gunner rule), applied at the DOOR: on a single-panel
    // product, request text belongs INSIDE the one generation — never a
    // composited lockup. This must happen BEFORE the standalone-layers
    // routing, or a "bowl that says X" rides the layer path and skips the
    // rule entirely (the reported Pet Bowl failure).
    if (renderableSpecs.length === 1 && convertedTexts.size) {
      for (const [layer, original] of convertedTexts) {
        const at = effectiveLayers.indexOf(layer);
        if (at >= 0) {
          effectiveLayers.splice(at, 1);
          if (!requiredText.some((t) => t.toLowerCase() === original.toLowerCase())) {
            requiredText.push(original);
          }
        }
      }
      convertedTexts.clear();
    }

    // Layers ARE the whole design only when the intent says so AND there is
    // no all-over/pattern artwork underneath them. On printed-surface
    // products a stated color VETOES standalone: layers composite onto
    // transparent (= white product), so "red sports bra that says X" must
    // instead generate a red base and overlay the layers on top of it
    // (live incidents: white bra, white laptop sleeve).
    const layersStandalone =
      effectiveLayers.length > 0 &&
      intent.layers_only &&
      !intent.all_over &&
      !intent.wants_repeat_pattern &&
      !preferAop &&
      !(printedSurface && statedBaseColor);

    note("route", `layersStandalone=${layersStandalone} layers=${effectiveLayers.length} layers_only=${intent.layers_only}`);
    if (layersStandalone) {
      // 6-pre. LAYERED COMPOSITION: the intent call planned grounded layers
      // (specific text/elements at specific piece positions); the engine
      // renders each as a transparent asset and composites at exact pixels.
      const renderable = renderableSpecs;
      const profile = layerProfile;
      const grouped = groupLayers(effectiveLayers);
      activeSpecs = [...grouped.keys()].map(
        (placement) => renderable.find((s) => s.placement === placement)!
      );
      result.strategy = "direct";
      result.coverage = "single";
      const provenance = [];
      for (const spec of activeSpecs) {
        const compiledLayer = await compileLayeredPanel({
          media: metered,
          spec,
          layers: grouped.get(spec.placement)!,
          imageUrls,
          runId,
          calibration: profile?.[spec.placement] ?? profile?.default,
          host: hostImage
        });
        result.panels.push(compiledLayer.panel);
        provenance.push(compiledLayer.provenance);
      }
      result.design_genome = {
        version: "threadbot-genome/1",
        run_id: runId,
        strategy: "direct",
        master_artwork_url: null,
        pattern_tile_url: null,
        panels: provenance
      };
    } else if (verbatimEntry) {
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

      // TEXT POLICY (the Gunner rule): text is part of the image generation
      // wherever the generator can handle it — any single-panel product. On
      // single-panel plans, lockup layers that merely carry request text are
      // DROPPED and the text returns to the generation prompt. Lockups exist
      // only for multi-panel products, where in-master text could straddle a
      // cut line; there, the text is scrubbed from every other prompt.
      if (activeSpecs.length === 1 && convertedTexts.size) {
        for (const [layer, original] of convertedTexts) {
          const at = effectiveLayers.indexOf(layer);
          if (at >= 0) {
            effectiveLayers.splice(at, 1);
            if (!requiredText.some((t) => t.toLowerCase() === original.toLowerCase())) {
              requiredText.push(original);
            }
          }
        }
      }
      if (requiredText.length && activeSpecs.length > 1) {
        const primary = pickPrimaryPlacement(activeSpecs);
        requiredText.slice(0, 2).forEach((text, i) => {
          effectiveLayers.push({
            kind: "element",
            content: typographyPrompt(text, ""),
            image_index: null,
            placement: primary.placement,
            cx_frac: 0.5,
            cy_frac: 0.3 + i * 0.25,
            width_frac: 0.55,
            rotation_deg: 0,
            color: "",
            order: 50 + i
          });
        });
        requiredText = [];
      }

      const layerCarriedTexts = [
        ...convertedTexts.values(),
        ...effectiveLayers
          .filter((l) => l.kind === "element" && /"([^"]{1,80})"/.test(l.content))
          .map((l) => (l.content.match(/"([^"]{1,80})"/) ?? [])[1] ?? "")
      ].filter((t) => t && !requiredText.some((r) => r.toLowerCase() === t.toLowerCase()));
      const design: DesignSpec = {
        artwork_brief: scrubTextFromBrief(brief, layerCarriedTexts),
        style_terms: intent.style_terms,
        // Printed-surface color rides the palette (and the brief directive);
        // base_product_color is fabric-variant context, DTG only.
        palette:
          printedSurface && statedBaseColor
            ? [statedBaseColor, ...intent.palette]
            : intent.palette,
        mood_terms: intent.mood_terms,
        required_text: requiredText,
        // When a lockup layer owns the text, the master must paint ZERO
        // lettering of its own (live incident: ghost yellow letterforms
        // behind the real lockup on the red sports bra).
        forbidden_text: layerCarriedTexts.length
          ? [...intent.forbidden_text, "any words, letters, or typography (text is applied separately)"]
          : intent.forbidden_text,
        base_product_color: printedSurface ? undefined : intent.garment_color || undefined,
        // Oversized/wrapping requests opt OUT of front-zone hero containment.
        hero_containment: !/\bwrap|spann?ing|across the (whole|entire)|oversiz|blown[- ]?up|zoomed/i.test(text),
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

      // 6c. OVERLAY PASS: grounded layers composite ON TOP of the compiled
      // artwork ("AOP grunge shirt with '745' across the chest" = master art
      // on every panel, then the exact-placed layer over the chest).
      if (effectiveLayers.length) {
        const grouped = groupLayers(effectiveLayers);
        for (const [placement, layerList] of grouped) {
          const spec = renderableSpecs.find((s) => s.placement === placement)!;
          const panel = result.panels.find(
            (p) => p.placement === placement && p.status === "success" && p.file_url
          );
          if (!panel) continue; // layer targeted a placement outside this plan
          const overlay = await renderLayerOverlay({
            media: metered,
            spec,
            layers: layerList,
            imageUrls,
            runId,
            calibration: layerProfile?.[placement] ?? layerProfile?.default
          });
          const base = await fetchPanelBytes(panel.file_url as string);
          // JPEG discipline: a print-res PNG composite runs 90MB+ and hangs
          // Printful's file fetch forever (the leggings timeout). The base
          // art is opaque, so q92 JPEG is visually identical at ~5MB.
          const composed = await sharp(base)
            .resize(overlay.canvasW, overlay.canvasH, { fit: "fill" })
            .composite([{ input: overlay.buffer }])
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 92 })
            .toBuffer();
          panel.file_url = await hostImage(composed, "image/jpeg");
          const smallComposite = await sharp(composed)
            .resize({ width: Math.min(1800, overlay.canvasW) })
            .jpeg({ quality: 85 })
            .toBuffer();
          panel.mockup_file_url = await hostImage(smallComposite, "image/jpeg");
          panel.notes = `${panel.notes} Layered overlay applied: ${overlay.promptParts.join(" + ")} (grounded piece-space compositing).`;
          result.design_genome?.panels.push({
            job_id: `overlay_${placement}`,
            placement,
            strategy: "reference_derive",
            model: null,
            seed: null,
            prompt: overlay.promptParts.join(" + "),
            plane_rect_in: null,
            crop_px: null,
            tile_phase_px: null,
            upscale_factor: null,
            target_px: { width: overlay.canvasW, height: overlay.canvasH },
            dpi: spec.dpi,
            transparent: false,
            source_urls: overlay.sourceUrls,
            printful_file_id: null
          });
        }
      }
    }

    const techniqueByPlacement = new Map(activeSpecs.map((spec) => [spec.placement, spec.technique]));
    result.submitted_placements = result.panels
      .filter((panel) => panel.status === "success" && panel.file_url && panel.must_render_in_mockup)
      .map((panel) => ({
        placement: panel.placement,
        technique: techniqueByPlacement.get(panel.placement) ?? "dtg",
        // Mockup tasks get the <=2048px copy (Printful renders at <=2000px;
        // print-res files made tasks take minutes); orders use file_url.
        fileUrl: (panel.mockup_file_url ?? panel.file_url) as string,
        file_url: panel.file_url as string
      }));

    // 7. Official Printful mockups — the hard-coded final-output rule.
    // Style ids: primary placement's first, then any placement's (a few
    // catalog products list styles on secondary placements only). Task
    // weight scales with styles x placements: heavy products get ONE style
    // so Printful renders within our patience window (leggings proved 2
    // styles x 3 placements can exceed 400s).
    // Task weight = styles x placements at Printful's renderer: heavy
    // multi-panel products (AOP hoodies: 6 placements) get ONE style so the
    // task finishes inside the run's patience window.
    const styleBudget = result.submitted_placements.length >= 4 ? 1 : 2;
    const styleIds = (
      pickPrimaryPlacement(activeSpecs).styleIds.length
        ? pickPrimaryPlacement(activeSpecs).styleIds
        : [...new Set(activeSpecs.flatMap((spec) => spec.styleIds))]
    ).slice(0, styleBudget);
    const productOptions = optionNames.includes("stitch_color")
      ? { stitch_color: pickStitchColor(intent) }
      : undefined;
    result.product_options = productOptions;
    stageMs.panels = Date.now() - tIntent - (stageMs.intent ?? 0);
    const tMockups = Date.now();
    // Network quiet before Printful's file fetches (see hosting.ts).
    const quietMs = await waitForDurablePersists(90000);
    note("durable_wait", `${quietMs}ms until durable uploads settled`);
    note(
      "mockup_submit",
      JSON.stringify({
        productId: product.productId,
        variantId,
        styleIds,
        productOptions,
        placements: result.submitted_placements.map((p) => ({ placement: p.placement, technique: p.technique, url: p.fileUrl }))
      })
    );
    for (const panel of result.panels) {
      note("panel", `${panel.placement}: ${panel.status} — ${panel.notes.slice(0, 120)}`);
    }
    const rendered = await resolved.renderMockups({
      productId: product.productId,
      variantIds: [variantId],
      placements: result.submitted_placements.map(({ placement, technique, fileUrl }) => {
        const spec = activeSpecs.find((s) => s.placement === placement);
        return {
          placement,
          technique,
          fileUrl,
          widthPx: spec ? Math.round(spec.widthIn * spec.dpi) : undefined,
          heightPx: spec ? Math.round(spec.heightIn * spec.dpi) : undefined
        };
      }),
      styleIds,
      productOptions,
      format: "jpg",
      widthPx: 1000,
      // Multi-placement AOP tasks render slowly; proven live: a 6-panel
      // hoodie needs >150s and 3-placement leggings exceeded 400s.
      // Patience is free — regeneration is not.
      maxAttempts: 100,
      intervalSeconds: 5,
      onEvent: (info) => note("mockup_poll", info)
    });
    stageMs.mockups = Date.now() - tMockups;
    note("mockup_result", `${rendered.status} via=${rendered.via ?? "?"} mockups=${rendered.mockups.length}`);

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

  result.economics.stage_ms = stageMs;
  finishEconomics(result, meter, llmCalls);
  return result;
};
