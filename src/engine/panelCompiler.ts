/**
 * Panel Compiler: deterministic full-coverage artwork execution.
 *
 * This engine exists because the two historical Threadbot failure modes are
 * both orchestration failures, not model failures:
 *
 *   FAILURE 1 — "seamless AOP breaks": panels were generated independently
 *   and a generative model was asked to make edges match. Fix: author art
 *   once on the shared garment plane (master composition or seamless tile),
 *   then CUT each panel with exact pixel math. Adjacent panels share cut
 *   lines; a tiled pattern is sampled from one infinite plane using each
 *   panel's garment-space offset. Continuity is arithmetic, not inference.
 *
 *   FAILURE 2 — "one panel filled, others blank": an agent looped over jobs
 *   and stopped early. Fix: the engine receives the ENTIRE surface plan in
 *   one call and returns one entry per job, always — generated, sliced,
 *   tiled, mirrored, derived, or intentionally blank. Coverage is checked in
 *   code and missing required panels are reported deterministically. Partial
 *   bundles cannot be silently produced.
 *
 * Execution strategies (chosen from the plan, per product):
 *   - direct        single-placement products (e.g. Gildan 5000 front print)
 *                   and detached panels (pocket, labels, unknown placements)
 *   - master_slice  multi-panel garments with one continuous composition
 *                   (AOP crew neck: front/back/sleeves cut from one master)
 *   - pattern_tile  repeat-pattern AOP: one seamless swatch, deterministically
 *                   tiled into every panel at its exact spec, phase-locked in
 *                   garment space so repeats align across seams
 *   - mirror        mirror_from_pair panels are a deterministic horizontal
 *                   flip of their source panel's file
 *
 * Every panel path ends in a real hosted public URL: locally-cut panels are
 * re-entered via Runware imageUpload and finished with imageUpscale (which
 * both reaches print resolution and returns a hosted URL). Optional Printful
 * File Library mirroring makes files durable beyond Runware's URL retention.
 */

import sharp from "sharp";
import { clampFluxDimension } from "../runware/media.js";
import { IMAGE } from "../runware/models.js";
import {
  buildGarmentPlane,
  CalibrationProfile,
  classifyPlacement,
  PanelPlan,
  PanelRole
} from "./garmentSpace.js";
import {
  cropExact,
  fetchImage,
  mirrorHorizontal,
  RasterImage,
  tileExact,
  toBase64Png
} from "./raster.js";
import { DesignGenome, PanelProvenance, stableSeed } from "./provenance.js";
// printful file-library mirroring retired: see notes at former call sites.

// -----------------------------------------------------------------------------
// Inputs.
// -----------------------------------------------------------------------------

export interface CompileJob {
  job_id: string;
  placement: string;
  worker_type?: string;
  design_action?: string;
  must_generate?: boolean;
  must_render_in_mockup?: boolean;
  source_job_id?: string | null;
  prompt?: string;
  mapping_rule?: {
    mode?: string;
    anchor?: string;
    scale_strategy?: string;
  };
  geometry_contract?: {
    width_px?: number | null;
    height_px?: number | null;
    dpi?: number | null;
  };
  output_contract?: {
    transparent_background?: boolean;
  };
}

export interface DesignSpec {
  artwork_brief: string;
  style_terms?: string[];
  palette?: string[];
  mood_terms?: string[];
  negative_constraints?: string[];
  required_text?: string[];
  forbidden_text?: string[];
  base_product_color?: string;
  /** Compose the hero subject inside the primary (front) piece zone of the
   *  master (default true). False when the customer asks for oversized /
   *  wrapping art ("giant robot spanning the whole hoodie"). */
  hero_containment?: boolean;
  customer_image_urls?: string[];
  customer_image_captions?: string[];
  /** Physical repeat size for pattern strategies ("statement" ~12-16, "micro" ~3-4). */
  pattern_tile_inches?: number;
  /**
   * Per-panel build plan (the garment engine's decomposition layer). When
   * present, panels with a directive are rendered DETERMINISTICALLY: exact
   * vector base fills (solid/gradient — zero AI color drift) plus optional
   * per-panel generated art. Panels without a directive keep normal
   * generation. This is how "yellow left sleeve, blue right sleeve,
   * orange-to-tan gradient front, black hood, different logo per panel"
   * comes out EXACTLY as ordered.
   */
  panel_directives?: PanelDirectiveSpec[];
}

/** Engine-side mirror of the intent model's per-panel directive. */
export interface PanelDirectiveSpec {
  /** "front","back","left_sleeve","right_sleeve","hood","pocket","neck","all". */
  panel: string;
  fill: "solid" | "gradient" | "none";
  color_a: string;
  color_b: string;
  angle_deg: number;
  art_prompt: string;
  art_width_frac: number;
}

/** Injectable media surface so the engine is testable offline. */
export interface MediaLike {
  generateImage(params: {
    model?: string;
    positivePrompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    referenceImages?: Array<{ image: string; role?: string } | string>;
    seed?: number;
    /** Request native alpha output (LayerDiffuse-class transparency). */
    transparentBackground?: boolean;
  }): Promise<{ imageURL: string }>;
  removeBackground(imageUrl: string): Promise<{ imageURL: string }>;
  upscale(image: string, factor: 2 | 3 | 4): Promise<{ imageURL: string }>;
  uploadImage(image: string): Promise<string>;
  /** Host raw bytes at a public URL as-is (no upscale). Optional. */
  hostImage?(base64: string, contentType?: string): Promise<string>;
}

// -----------------------------------------------------------------------------
// Outputs.
// -----------------------------------------------------------------------------

export interface CompiledPanel {
  job_id: string;
  placement: string;
  status: "success" | "blank" | "failed";
  generation_mode: "generated" | "sliced" | "derived" | "repeated" | "mirrored" | "blank";
  file_url: string | null;
  /** Lightweight (<=2048px) copy submitted to the mockup generator. */
  mockup_file_url: string | null;
  file_type: "png" | "none";
  public_url: boolean;
  transparent_background: boolean;
  must_render_in_mockup: boolean;
  source_job_id: string | null;
  source_parent_url: string | null;
  geometry_applied: boolean;
  notes: string;
}

export interface CompileResult {
  strategy: "direct" | "master_slice" | "pattern_tile" | "hybrid";
  master_artwork_url: string | null;
  pattern_tile_url: string | null;
  panels: CompiledPanel[];
  missing_required_placements: Array<{ placement: string; reason: string }>;
  genome: DesignGenome;
  all_required_succeeded: boolean;
}

// -----------------------------------------------------------------------------
// Prompt assembly.
// -----------------------------------------------------------------------------

/** Field caps: hostile mega-strings must not become mega-prompts. */
const capField = (text: string, max = 1500) => (text.length > max ? text.slice(0, max) : text);

const joinTerms = (terms?: string[]) =>
  terms?.length ? capField(terms.slice(0, 24).join(", "), 600) : "";

const designCore = (design: DesignSpec): string => {
  const parts = [capField(design.artwork_brief ?? "", 2500)];
  const style = joinTerms(design.style_terms);
  if (style) parts.push(`style: ${style}`);
  const palette = joinTerms(design.palette);
  if (palette) parts.push(`palette: ${palette}`);
  const mood = joinTerms(design.mood_terms);
  if (mood) parts.push(`mood: ${mood}`);
  if (design.required_text?.length) {
    parts.push(
      `must include the exact text: ${design.required_text
        .slice(0, 8)
        .map((t) => `"${capField(t, 120)}"`)
        .join(", ")}`
    );
  }
  if (design.customer_image_captions?.length) {
    parts.push(
      `faithful to customer reference imagery: ${capField(
        design.customer_image_captions.slice(0, 10).join("; "),
        1200
      )}`
    );
  }
  return parts.filter(Boolean).join(". ");
};

const negativeFor = (design: DesignSpec): string => {
  const parts = [
    "garment photo, product mockup, human model, hanger, fabric folds, seam stitching lines, watermark"
  ];
  if (design.forbidden_text?.length || !design.required_text?.length) {
    if (design.forbidden_text?.length) {
      parts.push(`text: ${design.forbidden_text.join(", ")}`);
    }
  }
  if (design.negative_constraints?.length) parts.push(design.negative_constraints.join(", "));
  return parts.join(", ");
};

/**
 * Master prompt rules learned from live Printful runs: NEVER mention
 * garments, panels, unwraps, seams or cut regions — that invites the model
 * to literally draw cut lines and pattern-piece outlines into the art (the
 * "black lines" defect). The master is described purely as a continuous
 * mural; panel structure exists only in the slicing math.
 */
const masterPrompt = (design: DesignSpec, zoned = false): string =>
  `One single continuous mural artwork filling the entire canvas edge to edge. ` +
  `${designCore(design)}. ` +
  `The scene flows uninterrupted across the whole canvas: no borders, no frames, no straight dividing lines, ` +
  `no outlines, no diagrams, no split composition, no text. ` +
  (zoned
    ? ""
    : `Evenly distributed organic composition; important subjects spread across the middle of the canvas ` +
      `and kept away from all edges. `) +
  `Flat print-ready textile artwork, rich detail, cohesive color and lighting.`;

const tilePrompt = (design: DesignSpec): string =>
  `Seamless repeating textile pattern swatch, edges wrap perfectly for infinite tiling in all directions, ` +
  `uniform density, no border, no vignette. ${designCore(design)}. Flat print-ready pattern.`;

const panelPrompt = (design: DesignSpec, job: CompileJob): string => {
  const anchor = job.mapping_rule?.anchor
    ? ` Composition anchored ${capField(job.mapping_rule.anchor, 80)}.`
    : "";
  // Print-safe framing: keep the subject comfortably inside the canvas so
  // provider safe-area cropping never clips it.
  return (
    `${designCore(design)}.${anchor} A single cohesive graphic composition centered on the canvas ` +
    `with generous margin on all sides; nothing important within the outer tenth of the image. ` +
    `No borders, no frames, no text unless specified. Flat print-ready apparel graphic, high detail.`
  );
};

// -----------------------------------------------------------------------------
// Deterministic base fills (panel directives).
// -----------------------------------------------------------------------------

/** The 148 CSS named colors — the vector renderer's exact-color vocabulary. */
const CSS_COLOR_NAMES = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(/\s+/)
);

/**
 * Normalize a customer/model color into something the vector renderer can
 * print EXACTLY: hex passes through, CSS names (with or without spaces —
 * "light blue") resolve, and descriptive phrases salvage their last real hue
 * word ("sunset orange" -> orange). Null when no printable color exists.
 */
export const resolveCssColor = (raw: string): string | null => {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(text)) return text;
  const joined = text.replace(/[^a-z]/g, "");
  if (CSS_COLOR_NAMES.has(joined)) return joined;
  const words = text.split(/[^a-z]+/).filter(Boolean).reverse();
  for (const word of words) if (CSS_COLOR_NAMES.has(word)) return word;
  return null;
};

/**
 * Exact vector base surface for a directive panel. Solid or two-stop linear
 * gradient; angle 0 = left-to-right, 90 = top-to-bottom (the natural garment
 * gradient). SVG-rendered by sharp, so the ink color is mathematically the
 * requested color — the red-bra-came-back-white class of drift is impossible.
 */
export const baseFillSvg = (
  width: number,
  height: number,
  fill: "solid" | "gradient",
  colorA: string,
  colorB: string,
  angleDeg: number
): string => {
  if (fill === "gradient") {
    const rad = ((Number.isFinite(angleDeg) ? angleDeg : 90) * Math.PI) / 180;
    const dx = 0.5 * Math.cos(rad);
    const dy = 0.5 * Math.sin(rad);
    const c = (v: number) => (0.5 + v).toFixed(4);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<defs><linearGradient id="g" x1="${c(-dx)}" y1="${c(-dy)}" x2="${c(dx)}" y2="${c(dy)}">` +
      `<stop offset="0" stop-color="${colorA}"/><stop offset="1" stop-color="${colorB}"/>` +
      `</linearGradient></defs>` +
      `<rect width="${width}" height="${height}" fill="url(#g)"/></svg>`
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${colorA}"/></svg>`
  );
};

// -----------------------------------------------------------------------------
// Sizing math.
// -----------------------------------------------------------------------------

/**
 * Pick the working (pre-upscale) size and upscale factor for a target spec.
 * Working output stays within generation/upload-friendly bounds; the final
 * upscaled result meets or exceeds the target at the exact aspect ratio.
 * Factor is restricted to 2 or 4 — Runware's imageUpscale rejects 3.
 */
export const workingSize = (targetW: number, targetH: number) => {
  const maxDim = Math.max(targetW, targetH);
  const factor = (maxDim <= 4096 ? 2 : 4) as 2 | 4;
  return {
    factor,
    width: Math.max(16, Math.ceil(targetW / factor)),
    height: Math.max(16, Math.ceil(targetH / factor))
  };
};

/**
 * Hard bounds on print-file dimensions. Anything outside is a corrupted or
 * hostile geometry contract — clamped so degenerate inputs (0, NaN, 1e9)
 * cannot explode raster memory or produce absurd files.
 */
const MIN_TARGET_PX = 16;
const MAX_TARGET_PX = 16000;

const jobTarget = (job: CompileJob) => {
  const dpi = Math.min(1200, Math.max(36, numberOr(job.geometry_contract?.dpi, 150)));
  const clampPx = (value: number) =>
    Math.min(MAX_TARGET_PX, Math.max(MIN_TARGET_PX, Math.round(value)));
  return {
    width: clampPx(numberOr(job.geometry_contract?.width_px, 12 * dpi)),
    height: clampPx(numberOr(job.geometry_contract?.height_px, 16 * dpi)),
    dpi
  };
};

const numberOr = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isBlank = (job: CompileJob) =>
  job.design_action === "leave_blank" || job.must_generate === false;

const wantsTransparency = (job: CompileJob): boolean => {
  if (typeof job.output_contract?.transparent_background === "boolean") {
    return job.output_contract.transparent_background;
  }
  // Full-bleed panel families default opaque; badge-like art defaults cutout.
  const fullBleed =
    job.worker_type === "wrap" ||
    job.worker_type === "pattern" ||
    job.worker_type === "side" ||
    job.design_action === "repeat_pattern" ||
    job.design_action === "slice_from_master";
  return !fullBleed;
};

// -----------------------------------------------------------------------------
// Strategy classification.
// -----------------------------------------------------------------------------

export const classifyStrategy = (
  jobs: CompileJob[]
): "direct" | "master_slice" | "pattern_tile" => {
  const active = jobs.filter((job) => !isBlank(job));
  if (active.length <= 1) return "direct";
  const patternVotes = active.filter(
    (job) =>
      job.design_action === "repeat_pattern" || job.mapping_rule?.mode === "pattern_tile"
  ).length;
  if (patternVotes >= Math.ceil(active.length / 2)) return "pattern_tile";
  const sliceable = active.filter(
    (job) => classifyPlacement(job.placement) !== "detached" && classifyPlacement(job.placement) !== "label"
  );
  return sliceable.length > 1 ? "master_slice" : "direct";
};

/** Deterministic coverage accounting — the anti-"blank panels" guarantee. */
export const computeMissingRequired = (
  jobs: CompileJob[],
  panels: CompiledPanel[]
): Array<{ placement: string; reason: string }> => {
  const byJob = new Map(panels.map((panel) => [panel.job_id, panel]));
  const missing: Array<{ placement: string; reason: string }> = [];
  for (const job of jobs) {
    const panel = byJob.get(job.job_id);
    if (!panel) {
      missing.push({ placement: job.placement, reason: "job produced no bundle entry" });
      continue;
    }
    const required = !isBlank(job) && job.must_render_in_mockup !== false;
    if (required && (panel.status !== "success" || !panel.file_url)) {
      missing.push({
        placement: job.placement,
        reason: panel.notes || "required placement has no generated file"
      });
    }
  }
  return missing;
};

// -----------------------------------------------------------------------------
// Compiler.
// -----------------------------------------------------------------------------

export class PanelCompiler {
  constructor(private readonly media: MediaLike) {}

  async compile(
    runId: string,
    jobs: CompileJob[],
    design: DesignSpec,
    profile?: CalibrationProfile
  ): Promise<CompileResult> {
    const strategy = classifyStrategy(jobs);
    const provenance: PanelProvenance[] = [];
    const panels: CompiledPanel[] = [];
    let masterUrl: string | null = null;
    let tileUrl: string | null = null;

    const record = (panel: CompiledPanel, prov: PanelProvenance) => {
      panels.push(panel);
      provenance.push(prov);
    };

    const blankJobs = jobs.filter(isBlank);
    const activeJobs = jobs.filter((job) => !isBlank(job));

    // Intentional blanks are first-class bundle citizens.
    for (const job of blankJobs) {
      const target = jobTarget(job);
      record(
        {
          job_id: job.job_id,
          placement: job.placement,
          status: "blank",
          generation_mode: "blank",
          file_url: null,
          mockup_file_url: null,
          file_type: "none",
          public_url: false,
          transparent_background: false,
          must_render_in_mockup: false,
          source_job_id: null,
          source_parent_url: null,
          geometry_applied: false,
          notes: "Intentionally blank per surface plan (leave_blank)."
        },
        {
          job_id: job.job_id,
          placement: job.placement,
          strategy: "blank",
          model: null,
          seed: null,
          prompt: null,
          plane_rect_in: null,
          crop_px: null,
          tile_phase_px: null,
          upscale_factor: null,
          target_px: { width: target.width, height: target.height },
          dpi: target.dpi,
          transparent: false,
          source_urls: [],
          printful_file_id: null
        }
      );
    }

    // Defer mirror jobs until their source panel exists.
    const mirrorJobs = activeJobs.filter((job) => job.design_action === "mirror_from_pair");
    const primaryJobs = activeJobs.filter((job) => job.design_action !== "mirror_from_pair");

    // Per-panel directives take over the whole plan: every active job (mirror
    // jobs included — a "yellow left sleeve, blue right sleeve" order must
    // never mirror one sleeve into the other) renders from its directive;
    // jobs without one keep normal generation.
    let deferredMirrors = mirrorJobs;
    const directed = Boolean(design.panel_directives?.length);
    if (directed) {
      deferredMirrors = await this.compilePanelDirectives(runId, activeJobs, design, record);
    } else if (strategy === "pattern_tile") {
      tileUrl = await this.compilePatternTile(runId, primaryJobs, design, record, profile);
    } else if (strategy === "master_slice") {
      const roles = new Set(primaryJobs.map((job) => classifyPlacement(job.placement)));
      const sleeved =
        roles.has("front") && (roles.has("left_sleeve") || roles.has("right_sleeve"));
      masterUrl = sleeved
        ? await this.compileWornViews(runId, primaryJobs, design, record, profile)
        : await this.compileMasterSlice(runId, primaryJobs, design, record, profile);
    } else {
      for (const job of primaryJobs) {
        await this.generateDirect(runId, job, design, null, record);
      }
    }

    for (const job of deferredMirrors) {
      await this.compileMirror(runId, job, panels, record);
    }

    const missing = computeMissingRequired(jobs, panels);
    const effectiveStrategy = directed ? "hybrid" : strategy;
    const genome: DesignGenome = {
      version: "threadbot-genome/1",
      run_id: runId,
      strategy: effectiveStrategy,
      master_artwork_url: masterUrl,
      pattern_tile_url: tileUrl,
      panels: provenance
    };
    return {
      strategy: effectiveStrategy,
      master_artwork_url: masterUrl,
      pattern_tile_url: tileUrl,
      panels,
      missing_required_placements: missing,
      genome,
      all_required_succeeded: missing.length === 0
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * Locally-produced pixels -> hosted public URLs.
   *
   * Returns TWO urls per panel:
   *  - fileUrl: print-resolution (upscaled) — what an ORDER submits
   *  - mockupUrl: the working buffer as-is (already <=2048px) — what the
   *    MOCKUP task submits. Printful renders mockups at <=2000px and
   *    preprocessing giant print files is what made tasks take minutes
   *    ("downscale your print file to 2000px... reduces processing time",
   *    per Printful's own docs). Falls back to fileUrl when the media
   *    backend cannot host raw buffers.
   */
  private async hostWorkingBuffer(
    buffer: Buffer,
    factor: 2 | 3 | 4,
    transparent: boolean
  ): Promise<{ fileUrl: string; mockupUrl: string }> {
    const uuid = await this.media.uploadImage(toBase64Png(buffer));
    const upscaled = await this.media.upscale(uuid, factor);
    let fileUrl = upscaled.imageURL;
    if (transparent) {
      fileUrl = (await this.media.removeBackground(fileUrl)).imageURL;
    }
    let mockupUrl = fileUrl;
    if (this.media.hostImage) {
      try {
        const small = transparent
          ? await sharp(buffer).png().toBuffer()
          : await sharp(buffer).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
        mockupUrl = await this.media.hostImage(
          small.toString("base64"),
          transparent ? "image/png" : "image/jpeg"
        );
      } catch {
        // mockup copy is an optimization; the print file always works
      }
    }
    return { fileUrl, mockupUrl };
  }

  /**
   * PANEL DIRECTIVE ENGINE — "literally do anything, per panel."
   *
   * The intent model decomposes explicit per-panel orders ("yellow left
   * sleeve, blue right sleeve, orange-to-tan gradient front, green-to-purple
   * back, black hood, a different logo on each panel") into one directive per
   * panel. Execution is split by what each piece NEEDS:
   *   - base fills render as VECTOR math (sharp/SVG) — the exact requested
   *     color or gradient, deterministic to the pixel, zero AI drift;
   *   - per-panel art/text generates with native alpha and composites into
   *     the panel's print-safe zone;
   *   - panels with no directive keep normal generation; mirror jobs whose
   *     role has a directive render their OWN directive (never a copy of the
   *     opposite sleeve).
   *
   * Returns the mirror jobs it did NOT handle (caller mirrors them normally).
   */
  private async compilePanelDirectives(
    runId: string,
    jobs: CompileJob[],
    design: DesignSpec,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void
  ): Promise<CompileJob[]> {
    const byRole = new Map<PanelRole, PanelDirectiveSpec>();
    let fallbackDirective: PanelDirectiveSpec | null = null;
    for (const directive of (design.panel_directives ?? []).slice(0, 16)) {
      const key = (directive.panel ?? "").trim().toLowerCase();
      if (["all", "everything", "rest", "other", "others"].includes(key)) {
        fallbackDirective ??= directive;
        continue;
      }
      const role = classifyPlacement(key);
      if (!byRole.has(role)) byRole.set(role, directive);
    }

    const deferredMirrors: CompileJob[] = [];
    for (const job of jobs) {
      const role = classifyPlacement(job.placement);
      const directive = byRole.get(role) ?? fallbackDirective;
      const actionable =
        directive && (directive.fill !== "none" || directive.art_prompt?.trim());
      if (!actionable) {
        if (job.design_action === "mirror_from_pair") deferredMirrors.push(job);
        else await this.generateDirect(runId, job, design, null, record);
        continue;
      }
      try {
        await this.renderDirectivePanel(runId, job, design, directive, record);
      } catch (error) {
        this.recordFailure(job, `Panel directive failed: ${(error as Error).message}`, record);
      }
    }
    return deferredMirrors;
  }

  /** Render ONE panel from its directive: vector base + optional generated art. */
  private async renderDirectivePanel(
    runId: string,
    job: CompileJob,
    design: DesignSpec,
    directive: PanelDirectiveSpec,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void
  ): Promise<void> {
    const target = jobTarget(job);
    const sizing = workingSize(target.width, target.height);
    const width = sizing.width;
    const height = sizing.height;
    const colorA = resolveCssColor(directive.color_a) ?? "#ffffff";
    const colorB = resolveCssColor(directive.color_b) ?? colorA;
    const fill = directive.fill === "gradient" && colorB === colorA ? "solid" : directive.fill;

    // Base surface: exact vector fill; "none" prints white (sublimation's
    // unprinted color) so the art still sits on a clean surface.
    const base =
      fill === "none"
        ? await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
            .png()
            .toBuffer()
        : await sharp(Buffer.from(baseFillSvg(width, height, fill, colorA, colorB, directive.angle_deg)))
            .resize(width, height, { fit: "fill" })
            .png()
            .toBuffer();

    let buffer = base;
    const prompt = capField((directive.art_prompt ?? "").trim(), 1200);
    const seed = stableSeed(runId, job.job_id, "directive-art");
    let model: string | null = null;
    if (prompt) {
      // Art box inside the print-safe zone: sized by the directive's width
      // fraction, capped so nothing crowds the panel edges.
      const widthFrac = Math.min(0.9, Math.max(0.15, numberOr(directive.art_width_frac, 0.5)));
      const artW = Math.max(64, Math.round(width * widthFrac));
      const artH = Math.max(64, Math.min(Math.round(height * 0.55), artW));
      const isTypography = /"[^"]+"|\btext\b|\btypograph|\bletter/i.test(prompt);
      model = isTypography ? IMAGE.RECRAFT_V4_1_PRO : IMAGE.FLUX_1_DEV;
      const genScale = Math.min(1536 / artW, 1536 / artH, 2);
      let generated: { imageURL: string };
      let nativeAlpha = !isTypography;
      const artPrompt =
        `${prompt}. Single isolated subject centered with clear margin on all sides, ` +
        `nothing cropped, no background scenery.`;
      try {
        generated = await this.media.generateImage({
          model,
          positivePrompt: artPrompt,
          negativePrompt: negativeFor(design),
          width: clampFluxDimension(artW * genScale),
          height: clampFluxDimension(artH * genScale),
          seed,
          ...(nativeAlpha ? { layerDiffuse: true } : {})
        } as Parameters<MediaLike["generateImage"]>[0]);
      } catch {
        // LayerDiffuse/typography path failed — plain generation + cutout.
        model = IMAGE.FLUX_2_FLEX;
        nativeAlpha = false;
        generated = await this.media.generateImage({
          model,
          positivePrompt: artPrompt,
          negativePrompt: negativeFor(design),
          width: clampFluxDimension(artW * genScale),
          height: clampFluxDimension(artH * genScale),
          seed
        });
      }
      let artUrl = generated.imageURL;
      if (!nativeAlpha) {
        artUrl = (await this.media.removeBackground(artUrl)).imageURL;
      }
      const artResponse = await fetch(artUrl);
      if (!artResponse.ok) throw new Error(`art fetch HTTP ${artResponse.status}`);
      const art = await sharp(Buffer.from(await artResponse.arrayBuffer()))
        .resize(artW, artH, { fit: "inside" })
        .png()
        .toBuffer();
      const artMeta = await sharp(art).metadata();
      const aw = artMeta.width ?? artW;
      const ah = artMeta.height ?? artH;
      const role = classifyPlacement(job.placement);
      // Chest height on body panels; dead center everywhere else.
      const cy = role === "front" || role === "back" ? 0.42 : 0.5;
      buffer = await sharp(base)
        .composite([
          {
            input: art,
            left: Math.max(0, Math.round(width / 2 - aw / 2)),
            top: Math.max(0, Math.min(height - ah, Math.round(height * cy - ah / 2)))
          }
        ])
        .png()
        .toBuffer();
    }

    const { fileUrl, mockupUrl } = await this.hostWorkingBuffer(buffer, sizing.factor, false);
    const fillNote =
      fill === "none"
        ? "no base fill"
        : fill === "solid"
          ? `solid ${colorA}`
          : `gradient ${colorA} -> ${colorB} @ ${Math.round(directive.angle_deg) || 90}°`;
    record(
      {
        job_id: job.job_id,
        placement: job.placement,
        status: "success",
        generation_mode: prompt ? "generated" : "derived",
        file_url: fileUrl,
        mockup_file_url: mockupUrl,
        file_type: "png",
        public_url: true,
        transparent_background: false,
        must_render_in_mockup: job.must_render_in_mockup !== false,
        source_job_id: job.source_job_id ?? null,
        source_parent_url: null,
        geometry_applied: true,
        notes: `Panel directive: ${fillNote} rendered as exact vector fill${
          prompt ? "; panel-specific art composited in the print-safe zone" : ""
        }.`
      },
      {
        job_id: job.job_id,
        placement: job.placement,
        strategy: "panel_directive",
        model,
        seed: prompt ? seed : null,
        prompt: prompt || `vector fill: ${fillNote}`,
        plane_rect_in: null,
        crop_px: null,
        tile_phase_px: null,
        upscale_factor: sizing.factor,
        target_px: { width: target.width, height: target.height },
        dpi: target.dpi,
        transparent: false,
        source_urls: [],
        printful_file_id: null
      }
    );
  }

  /**
   * WORN-VIEW PAINTER (the owner's "paint on the 3D garment, slice at the
   * seams, unfold" — realized with the geometry we have). Instead of one
   * flat plane row, the artwork is painted per WORN VIEW:
   *
   *   W_F (front view): [right-sleeve front half][FRONT][left-sleeve front
   *   half], hood above, pocket on the front — one continuous painting in
   *   true worn adjacency, hero scene guaranteed inside the front piece.
   *
   *   W_B (back view): [right-sleeve back half][BACK][left-sleeve back
   *   half] — painted as a CONTINUATION: seeded with the top-of-arm ridge
   *   strips and side-seam strips copied (mirrored) from W_F, so the two
   *   paintings share their border pixels before the model ever runs.
   *
   * Unfolding: body/hood/pocket crop straight out of their view; each
   * sleeve print is front half (from W_F) + back half (from W_B, mirrored
   * so its body edge lands on the underarm seam), joined with a feathered
   * cross-blend at the centerline — no hard line.
   */
  private async compileWornViews(
    runId: string,
    jobs: CompileJob[],
    design: DesignSpec,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void,
    profile?: CalibrationProfile
  ): Promise<string | null> {
    const plane = buildGarmentPlane(
      jobs.map((job) => ({
        placement: job.placement,
        width_px: job.geometry_contract?.width_px,
        height_px: job.geometry_contract?.height_px,
        dpi: job.geometry_contract?.dpi
      })),
      profile
    );
    const byRole = new Map(plane.panels.map((panel) => [panel.role, panel]));
    const byPlacement = new Map(plane.panels.map((panel) => [panel.placement, panel]));
    const front = byRole.get("front")!;
    const back = byRole.get("back");
    const ls = byRole.get("left_sleeve");
    const rs = byRole.get("right_sleeve");
    const hood = byRole.get("hood");
    const pocket = byRole.get("pocket");

    // Worn canvas layout (inches). Wearer-left arm sits at canvas-RIGHT in
    // BOTH views; sleeves keep the underarm drop so features hold their
    // worn height.
    const halfL = ls ? ls.widthIn / 2 : 0;
    const halfR = rs ? rs.widthIn / 2 : 0;
    const bodyW = Math.max(front.widthIn, back?.widthIn ?? 0);
    const bodyH = Math.max(front.heightIn, back?.heightIn ?? 0);
    const hoodH = hood ? hood.heightIn : 0;
    const drop = (sleeve: PanelPlan) => Math.max(0, 0.28 * bodyH - 0.17 * sleeve.heightIn);
    const canvasWIn = halfR + bodyW + halfL;
    const canvasHIn =
      hoodH +
      Math.max(
        bodyH,
        ...(ls ? [drop(ls) + ls.heightIn] : [0]),
        ...(rs ? [drop(rs) + rs.heightIn] : [0])
      );
    const scale = Math.min(2048 / canvasWIn, 2048 / canvasHIn);
    const W = clampFluxDimension(canvasWIn * scale);
    const H = clampFluxDimension(canvasHIn * scale);
    const px = { x: W / canvasWIn, y: H / canvasHIn };
    const rect = (xIn: number, yIn: number, wIn: number, hIn: number) => ({
      left: Math.max(0, Math.round(xIn * px.x)),
      top: Math.max(0, Math.round(yIn * px.y)),
      width: Math.max(8, Math.round(wIn * px.x)),
      height: Math.max(8, Math.round(hIn * px.y))
    });
    const frontRect = rect(halfR, hoodH, front.widthIn, front.heightIn);
    const backRect = back ? rect(halfR, hoodH, back.widthIn, back.heightIn) : null;
    const lsZone = ls ? rect(halfR + bodyW, hoodH + drop(ls), halfL, ls.heightIn) : null;
    const rsZone = rs ? rect(0, hoodH + drop(rs), halfR, rs.heightIn) : null;
    const hoodRect = hood
      ? rect(halfR + (bodyW - hood.widthIn) / 2, 0, hood.widthIn, hood.heightIn)
      : null;
    // Pocket keeps its calibrated offset relative to the front piece.
    const pocketRect = pocket
      ? rect(
          halfR + (pocket.xIn - front.xIn),
          hoodH + (pocket.yIn - front.yIn),
          pocket.widthIn,
          pocket.heightIn
        )
      : null;

    const seed = stableSeed(runId, "master");
    const references = design.customer_image_urls?.length
      ? design.customer_image_urls.map((image) => ({ image }))
      : undefined;
    const fetchBuf = async (url: string): Promise<Buffer> => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`fetch HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };

    let wfBuf: Buffer;
    let wbBuf: Buffer | null = null;
    let masterUrl: string | null = null;
    try {
      if (!this.media.hostImage) throw new Error("hostImage unavailable for worn-view painting");
      // ---- 1) Hero scene inside the front piece (containment law). ----
      const k = Math.min(1536 / frontRect.width, 1536 / frontRect.height, 1);
      const heroGen = await this.media.generateImage({
        model: IMAGE.FLUX_2_FLEX,
        positivePrompt:
          `A complete self-contained scene: every subject entirely visible with comfortable ` +
          `margin on all sides, nothing cropped at any edge. ${designCore(design)}. ` +
          `Flat print-ready textile artwork, rich detail, cohesive color and lighting. ` +
          `No borders, no frames, no split composition.`,
        negativePrompt: negativeFor(design),
        width: clampFluxDimension(frontRect.width * k),
        height: clampFluxDimension(frontRect.height * k),
        seed,
        referenceImages: references
      });
      const heroBufRaw = await fetchBuf(heroGen.imageURL);
      const hero = await sharp(heroBufRaw)
        .resize(frontRect.width, frontRect.height, { fit: "fill" })
        .png()
        .toBuffer();
      const mean = await sharp(heroBufRaw).resize(1, 1).removeAlpha().raw().toBuffer();
      const bg = { r: mean[0], g: mean[1], b: mean[2] };

      // ---- 2) Front worn view: outpaint sleeves/hood around the hero. ----
      const wfSeed = await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
        .composite([{ input: hero, left: frontRect.left, top: frontRect.top }])
        .jpeg({ quality: 92 })
        .toBuffer();
      const wfSeedUrl = await this.media.hostImage(wfSeed.toString("base64"), "image/jpeg");
      const wfGen = await this.media.generateImage({
        model: IMAGE.FLUX_2_FLEX,
        positivePrompt:
          `This is a garment painted AS WORN, seen from the front: torso center, sleeves at the ` +
          `sides, hood at the top. Extend the existing scene outward to fill the entire canvas as ` +
          `one continuous painting across the whole garment. Keep the existing detailed scene ` +
          `EXACTLY as it is. Fill all flat areas with seamlessly matching environment continuing ` +
          `the scene's world — no new focal subjects, no text. ${designCore(design).slice(0, 500)}`,
        width: W,
        height: H,
        seed,
        referenceImages: [{ image: wfSeedUrl }]
      });
      wfBuf = await sharp(await fetchBuf(wfGen.imageURL))
        .resize(W, H, { fit: "fill" })
        .composite([{ input: hero, left: frontRect.left, top: frontRect.top }])
        .png()
        .toBuffer();

      // ---- 3) Back worn view: continuation seeded with shared borders. ----
      if (back || ls || rs) {
        const ridgeComposites: Array<{ input: Buffer; left: number; top: number }> = [];
        const ridgeW = Math.max(8, Math.round((lsZone ?? rsZone ?? frontRect).width * 0.25));
        const flopStrip = async (zone: { left: number; top: number; width: number; height: number }, atOuterRight: boolean) => {
          const stripLeft = atOuterRight ? zone.left + zone.width - ridgeW : zone.left;
          const strip = await sharp(wfBuf)
            .extract({ left: stripLeft, top: zone.top, width: ridgeW, height: zone.height })
            .flop()
            .png()
            .toBuffer();
          return { input: strip, left: stripLeft, top: zone.top };
        };
        if (lsZone) ridgeComposites.push(await flopStrip(lsZone, true));
        if (rsZone) ridgeComposites.push(await flopStrip(rsZone, false));
        // Side seams: the front piece's outer columns wrap to the back piece.
        if (backRect) {
          const seamW = Math.max(8, Math.round(frontRect.width * 0.06));
          for (const side of ["left", "right"] as const) {
            const stripLeft = side === "left" ? frontRect.left : frontRect.left + frontRect.width - seamW;
            const strip = await sharp(wfBuf)
              .extract({ left: stripLeft, top: frontRect.top, width: seamW, height: frontRect.height })
              .flop()
              .png()
              .toBuffer();
            ridgeComposites.push({
              input: strip,
              left: side === "left" ? backRect.left : backRect.left + backRect.width - seamW,
              top: backRect.top
            });
          }
        }
        const wbSeed = await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
          .composite(ridgeComposites)
          .jpeg({ quality: 92 })
          .toBuffer();
        const wbSeedUrl = await this.media.hostImage(wbSeed.toString("base64"), "image/jpeg");
        const wbGen = await this.media.generateImage({
          model: IMAGE.FLUX_2_FLEX,
          positivePrompt:
            `The BACK view of the same worn garment, one continuous painting. The already-painted ` +
            `edge strips are the arm ridges and side seams shared with the front view — keep them ` +
            `EXACTLY and continue the same scene's world naturally across the whole canvas: same ` +
            `palette, same lighting, environment only, no new focal subjects, no text. ` +
            `${designCore(design).slice(0, 400)}`,
          width: W,
          height: H,
          seed: stableSeed(runId, "master", "back"),
          referenceImages: [{ image: wbSeedUrl }]
        });
        wbBuf = await sharp(await fetchBuf(wbGen.imageURL)).resize(W, H, { fit: "fill" }).png().toBuffer();
      }
      masterUrl = await this.media.hostImage(wfBuf.toString("base64"), "image/png");
    } catch (error) {
      // Painting failed — the proven single-master plane path takes over.
      console.warn(`[compiler] worn-view painting failed, falling back: ${(error as Error).message}`);
      return this.compileMasterSlice(runId, jobs, design, record, profile);
    }
    const wbUrl = wbBuf ? await this.media.hostImage(wbBuf.toString("base64"), "image/png") : null;

    // ---- 4) Unfold: crop each print file from its worn view. ----
    const viewOf = (role: PanelRole): { buf: Buffer; url: string | null } =>
      role === "back" && wbBuf ? { buf: wbBuf, url: wbUrl } : { buf: wfBuf, url: masterUrl };
    const cropView = async (
      buf: Buffer,
      zone: { left: number; top: number; width: number; height: number },
      outWidth: number,
      outHeight: number
    ): Promise<Buffer> =>
      sharp(buf)
        .extract({
          left: Math.min(Math.max(0, zone.left), W - 8),
          top: Math.min(Math.max(0, zone.top), H - 8),
          width: Math.min(zone.width, W - zone.left),
          height: Math.min(zone.height, H - zone.top)
        })
        .resize(outWidth, outHeight, { fit: "fill" })
        .png()
        .toBuffer();

    const sleeveFile = async (
      zone: { left: number; top: number; width: number; height: number },
      outWidth: number,
      outHeight: number,
      wearerLeft: boolean
    ): Promise<Buffer> => {
      // Front half from W_F, back half from W_B (mirrored); feathered
      // cross-blend across a 12% band at the centerline — no hard line.
      const halfW = Math.round(outWidth / 2);
      const blend = Math.max(8, Math.round(outWidth * 0.12));
      const wide = halfW + Math.round(blend / 2);
      const frontHalf = await cropView(wfBuf, zone, wide, outHeight);
      const backSrc = wbBuf ?? wfBuf;
      const backHalfRaw = await cropView(backSrc, zone, wide, outHeight);
      const backHalf = await sharp(backHalfRaw).flop().png().toBuffer();
      // Alpha ramp over the blend band on the back half's inner edge.
      const ramp = Buffer.alloc(wide * outHeight * 4);
      for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < wide; x++) {
          const i = (y * wide + x) * 4;
          const into = x - (wide - blend);
          const a = into <= 0 ? 255 : Math.max(0, Math.round(255 * (1 - into / blend)));
          ramp[i] = 255; ramp[i + 1] = 255; ramp[i + 2] = 255; ramp[i + 3] = a;
        }
      }
      const rampPng = await sharp(ramp, { raw: { width: wide, height: outHeight, channels: 4 } }).png().toBuffer();
      const frontFaded = await sharp(frontHalf)
        .ensureAlpha()
        .composite([{ input: rampPng, blend: "dest-in" }])
        .png()
        .toBuffer();
      const backFaded = await sharp(backHalf)
        .ensureAlpha()
        .composite([{ input: await sharp(rampPng).flop().png().toBuffer(), blend: "dest-in" }])
        .png()
        .toBuffer();
      // wearer-left sleeve template: front half on the LEFT; wearer-right mirrored.
      const composites = wearerLeft
        ? [
            { input: backFaded, left: outWidth - wide, top: 0 },
            { input: frontFaded, left: 0, top: 0 }
          ]
        : [
            { input: await sharp(backFaded).flop().png().toBuffer(), left: 0, top: 0 },
            { input: await sharp(frontFaded).flop().png().toBuffer(), left: outWidth - wide, top: 0 }
          ];
      return sharp({ create: { width: outWidth, height: outHeight, channels: 3, background: { r: 255, g: 255, b: 255 } } })
        .composite(composites)
        .png()
        .toBuffer();
    };

    const finishJob = async (job: CompileJob, buffer: Buffer, sourceUrls: string[], note: string) => {
      const target = jobTarget(job);
      const sizing = workingSize(target.width, target.height);
      const sized = await sharp(buffer).resize(sizing.width, sizing.height, { fit: "fill" }).png().toBuffer();
      const { fileUrl, mockupUrl } = await this.hostWorkingBuffer(sized, sizing.factor, false);
      record(
        {
          job_id: job.job_id,
          placement: job.placement,
          status: "success",
          generation_mode: "sliced",
          file_url: fileUrl,
          mockup_file_url: mockupUrl,
          file_type: "png",
          public_url: true,
          transparent_background: false,
          must_render_in_mockup: job.must_render_in_mockup !== false,
          source_job_id: job.source_job_id ?? null,
          source_parent_url: masterUrl,
          geometry_applied: true,
          notes: note
        },
        {
          job_id: job.job_id,
          placement: job.placement,
          strategy: "master_slice",
          model: IMAGE.FLUX_2_FLEX,
          seed,
          prompt: "worn-view painting (front+back views, unfolded at seams)",
          plane_rect_in: null,
          crop_px: null,
          tile_phase_px: null,
          upscale_factor: sizing.factor,
          target_px: { width: target.width, height: target.height },
          dpi: target.dpi,
          transparent: false,
          source_urls: sourceUrls,
          printful_file_id: null
        }
      );
    };

    for (const job of jobs) {
      const role = classifyPlacement(job.placement);
      const panel = byPlacement.get(job.placement)!;
      const target = jobTarget(job);
      try {
        if (role === "left_sleeve" && lsZone) {
          await finishJob(
            job,
            await sleeveFile(lsZone, target.width, target.height, true),
            [masterUrl!, ...(wbUrl ? [wbUrl] : [])],
            "Worn-view sleeve: front half continues the front view, back half the back view (mirrored), feathered centerline blend."
          );
        } else if (role === "right_sleeve" && rsZone) {
          await finishJob(
            job,
            await sleeveFile(rsZone, target.width, target.height, false),
            [masterUrl!, ...(wbUrl ? [wbUrl] : [])],
            "Worn-view sleeve: front half continues the front view, back half the back view (mirrored), feathered centerline blend."
          );
        } else {
          const zone =
            role === "front"
              ? frontRect
              : role === "back" && backRect
                ? backRect
                : role === "hood" && hoodRect
                  ? hoodRect
                  : role === "pocket" && pocketRect
                    ? pocketRect
                    : rect(halfR, hoodH, panel.widthIn, panel.heightIn);
          const view = viewOf(role);
          await finishJob(
            job,
            await cropView(view.buf, zone, target.width, target.height),
            view.url ? [view.url] : [],
            "Unfolded from the worn-view painting at the piece's worn position."
          );
        }
      } catch (error) {
        this.recordFailure(job, `Worn-view unfold failed: ${(error as Error).message}`, record);
      }
    }
    return masterUrl;
  }

  private async compileMasterSlice(
    runId: string,
    jobs: CompileJob[],
    design: DesignSpec,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void,
    profile?: CalibrationProfile
  ): Promise<string | null> {
    const plane = buildGarmentPlane(
      jobs.map((job) => ({
        placement: job.placement,
        width_px: job.geometry_contract?.width_px,
        height_px: job.geometry_contract?.height_px,
        dpi: job.geometry_contract?.dpi
      })),
      profile
    );
    const planeByPlacement = new Map(plane.panels.map((panel) => [panel.placement, panel]));
    const sliceJobs = jobs.filter((job) => planeByPlacement.get(job.placement)?.seamBound);
    const directJobs = jobs.filter((job) => !planeByPlacement.get(job.placement)?.seamBound);

    // Master canvas: the bounding box of the CANVAS WINDOWS (piece rects
    // plus their canvas margins) rendered at the largest resolution the
    // generator supports, exact aspect ratio preserved. Margins carry real
    // neighboring art, which becomes the seam allowance / bleed.
    const bound = sliceJobs
      .map((job) => planeByPlacement.get(job.placement)!)
      .reduce(
        (acc, panel) => ({
          x0: Math.min(acc.x0, panel.canvasXIn),
          y0: Math.min(acc.y0, panel.canvasYIn),
          x1: Math.max(acc.x1, panel.canvasXIn + panel.canvasWIn),
          y1: Math.max(acc.y1, panel.canvasYIn + panel.canvasHIn)
        }),
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      );
    const boundW = Math.max(bound.x1 - bound.x0, 0.1);
    const boundH = Math.max(bound.y1 - bound.y0, 0.1);
    const scale = Math.min(2048 / boundW, 2048 / boundH);
    const masterW = clampFluxDimension(boundW * scale);
    const masterH = clampFluxDimension(boundH * scale);
    const pxPerIn = { x: masterW / boundW, y: masterH / boundH };

    const seed = stableSeed(runId, "master");
    // PIXEL-PERFECT HERO CONTAINMENT (owner-mandated for all AOP masters):
    // 1) generate the complete hero scene alone at the front piece's aspect,
    // 2) paste it into the front-piece rect by math and OUTPAINT only the
    //    surroundings, 3) re-paste the pristine hero pixel-for-pixel — the
    // front panel is byte-identical to the hero by construction, and any
    // outpaint blend mismatch lands exactly on sewing seams. Falls back to
    // single-generation zone-law composition on any error.
    const frontPanel =
      planeByPlacement.get("front") ??
      (sliceJobs[0] ? planeByPlacement.get(sliceJobs[0].placement) : undefined);
    const frontRect = frontPanel
      ? {
          left: Math.round((frontPanel.xIn - bound.x0) * pxPerIn.x),
          top: Math.round((frontPanel.yIn - bound.y0) * pxPerIn.y),
          width: Math.max(16, Math.round(frontPanel.widthIn * pxPerIn.x)),
          height: Math.max(16, Math.round(frontPanel.heightIn * pxPerIn.y))
        }
      : null;
    const references = design.customer_image_urls?.length
      ? design.customer_image_urls.map((image) => ({ image }))
      : undefined;

    let master: RasterImage | null = null;
    let masterUrl: string | null = null;
    let heroMode = "single";
    if (
      design.hero_containment !== false &&
      frontRect &&
      this.media.hostImage &&
      (frontRect.width < masterW * 0.96 || frontRect.height < masterH * 0.96)
    ) {
      try {
        // 1) The hero scene, complete and self-contained, at piece aspect.
        const k = Math.min(1536 / frontRect.width, 1536 / frontRect.height, 1);
        const heroW = clampFluxDimension(frontRect.width * k);
        const heroH = clampFluxDimension(frontRect.height * k);
        const heroGen = await this.media.generateImage({
          model: IMAGE.FLUX_2_FLEX,
          positivePrompt:
            `A complete self-contained scene: every subject entirely visible with comfortable ` +
            `margin on all sides, nothing cropped at any edge. ${designCore(design)}. ` +
            `Flat print-ready textile artwork, rich detail, cohesive color and lighting. ` +
            `No borders, no frames, no split composition.`,
          negativePrompt: negativeFor(design),
          width: heroW,
          height: heroH,
          seed,
          referenceImages: references
        });
        const heroResponse = await fetch(heroGen.imageURL);
        if (!heroResponse.ok) throw new Error(`hero fetch HTTP ${heroResponse.status}`);
        const heroBuf = Buffer.from(await heroResponse.arrayBuffer());
        const hero = await sharp(heroBuf)
          .resize(frontRect.width, frontRect.height, { fit: "fill" })
          .png()
          .toBuffer();
        // 2) Seed canvas (hero pasted on its own mean color) -> outpaint.
        const mean = await sharp(heroBuf).resize(1, 1).removeAlpha().raw().toBuffer();
        const seedCanvas = await sharp({
          create: {
            width: masterW,
            height: masterH,
            channels: 3,
            background: { r: mean[0], g: mean[1], b: mean[2] }
          }
        })
          .composite([{ input: hero, left: frontRect.left, top: frontRect.top }])
          .jpeg({ quality: 92 })
          .toBuffer();
        const seedUrl = await this.media.hostImage(seedCanvas.toString("base64"), "image/jpeg");
        const outpainted = await this.media.generateImage({
          model: IMAGE.FLUX_2_FLEX,
          positivePrompt:
            `Extend this artwork outward so it fills the entire canvas as one continuous mural. ` +
            `Keep the existing detailed scene EXACTLY as it is, same position and scale. ` +
            `Replace every flat solid-color area with seamlessly matching environment: ground, sky, ` +
            `atmosphere, texture continuing the scene's world. No new focal subjects, no people, ` +
            `no animals, no text, no borders. ${designCore(design).slice(0, 600)}`,
          width: masterW,
          height: masterH,
          seed,
          referenceImages: [{ image: seedUrl }]
        });
        const outResponse = await fetch(outpainted.imageURL);
        if (!outResponse.ok) throw new Error(`outpaint fetch HTTP ${outResponse.status}`);
        // 3) Deterministic re-paste: the front zone is the hero, by law.
        const finalBuf = await sharp(Buffer.from(await outResponse.arrayBuffer()))
          .resize(masterW, masterH, { fit: "fill" })
          .composite([{ input: hero, left: frontRect.left, top: frontRect.top }])
          .png()
          .toBuffer();
        masterUrl = await this.media.hostImage(finalBuf.toString("base64"), "image/png");
        master = { buffer: finalBuf, width: masterW, height: masterH };
        heroMode = "hero_outpaint";
      } catch (error) {
        master = null;
        masterUrl = null;
        heroMode = `fallback: ${(error as Error).message.slice(0, 80)}`;
      }
    }
    if (!master) {
      // Fallback / opt-out: single master generation with zone-law guidance.
      let heroZone = "";
      if (design.hero_containment !== false && frontRect && (frontRect.width < masterW || frontRect.height < masterH)) {
        const cx = Math.round(((frontRect.left + frontRect.width / 2) / masterW) * 100);
        const cy = Math.round(((frontRect.top + frontRect.height / 2) / masterH) * 100);
        heroZone =
          ` COMPOSITION LAW: this is a WIDE ESTABLISHING SHOT. The complete main subject appears ` +
          `SMALL, centered near ${cx}% across and ${cy}% down the canvas, entirely visible with ` +
          `generous space around it. Everything else is pure environment — no additional subjects, ` +
          `nothing cropped at any edge.`;
      }
      const prompt = masterPrompt(design, heroZone !== "") + heroZone;
      try {
        const generated = await this.media.generateImage({
          model: IMAGE.FLUX_2_FLEX,
          positivePrompt: prompt,
          negativePrompt: negativeFor(design),
          width: masterW,
          height: masterH,
          seed,
          referenceImages: references
        });
        masterUrl = generated.imageURL;
        master = await fetchImage(masterUrl);
      } catch (error) {
        for (const job of jobs) {
          this.recordFailure(job, `Master generation failed: ${(error as Error).message}`, record);
        }
        return masterUrl;
      }
    }
    const prompt = `master(${heroMode})`;

    // Panels are independent once the master exists: slice/upscale/host them
    // CONCURRENTLY (an AOP hoodie is 6-7 panels of 6000px work — serial was
    // the "clocked forever" hot path). Results record in job order so bundles
    // stay deterministic. The Printful file-library mirror is fire-and-forget:
    // mockups and orders both consume our hosted URLs, never the mirror.
    // SLEEVE WORN-VIEW ASSEMBLY (owner-verified on a physical hoodie): a
    // sleeve print's vertical CENTERLINE divides what shows from the FRONT
    // view (one half) vs the BACK view (other half), with a hard line at the
    // centerline. Wearer's LEFT arm adjoins the front print's RIGHT edge
    // (front view) and the back print's RIGHT edge (back view); the right
    // arm mirrors this. Each sleeve file is therefore built from TWO strips
    // sampled at those exact junctions — the back-visible strip is placed
    // MIRRORED so its body-adjacent edge lands on the underarm seam (the
    // owner's own mirrored back-half artwork confirms this convention).
    const frontPlane = planeByPlacement.get("front");
    const backPlane = [...planeByPlacement.values()].find((p) => p.role === "back");
    const buildSleeveBuffer = async (
      job: CompileJob,
      role: "left_sleeve" | "right_sleeve",
      outWidth: number,
      outHeight: number,
      dpi: number
    ): Promise<Buffer> => {
      const panel = planeByPlacement.get(job.placement)!;
      const halfIn = panel.widthIn / 2;
      const yPx = (panel.yIn - bound.y0) * pxPerIn.y;
      const hPx = panel.heightIn * pxPerIn.y;
      const halfPx = halfIn * pxPerIn.x;
      const stripAt = async (xIn: number, mirrored: boolean): Promise<Buffer> => {
        const raw = await cropExact(master, {
          left: (xIn - bound.x0) * pxPerIn.x,
          top: yPx,
          width: halfPx,
          height: hPx,
          outWidth: Math.max(8, Math.round(outWidth / 2)),
          outHeight: outHeight,
          dpi
        });
        if (!mirrored) return raw;
        return sharp(raw).flop().png().toBuffer();
      };
      const front = frontPlane!;
      const back = backPlane ?? front;
      let leftHalf: Buffer;
      let rightHalf: Buffer;
      if (role === "left_sleeve") {
        // LEFT half (front-visible): continues front print's RIGHT edge.
        leftHalf = await stripAt(front.xIn + front.widthIn, false);
        // RIGHT half (back-visible): continues back print's RIGHT edge
        // (= the strip just right of the back|front cut), mirrored inward.
        rightHalf = await stripAt(back.xIn + back.widthIn, true);
      } else {
        // RIGHT half (front-visible): continues front print's LEFT edge.
        rightHalf = await stripAt(front.xIn - halfIn, false);
        // LEFT half (back-visible): continues back print's LEFT edge, mirrored.
        leftHalf = await stripAt(back.xIn - halfIn, true);
      }
      const leftW = Math.max(8, Math.round(outWidth / 2));
      return sharp({
        create: { width: outWidth, height: outHeight, channels: 3, background: { r: 255, g: 255, b: 255 } }
      })
        .composite([
          { input: leftHalf, left: 0, top: 0 },
          { input: rightHalf, left: leftW, top: 0 }
        ])
        .png()
        .toBuffer();
    };

    const sliceOne = async (job: CompileJob): Promise<Parameters<typeof record> | { failure: string }> => {
      const panel = planeByPlacement.get(job.placement)!;
      const target = jobTarget(job);
      const sizing = workingSize(target.width, target.height);
      // Crop the full CANVAS window: the piece region plus its margins,
      // which carry genuine neighboring art (bleed/seam allowance).
      const crop = {
        left: (panel.canvasXIn - bound.x0) * pxPerIn.x,
        top: (panel.canvasYIn - bound.y0) * pxPerIn.y,
        width: panel.canvasWIn * pxPerIn.x,
        height: panel.canvasHIn * pxPerIn.y
      };
      const transparent = wantsTransparency(job);
      const sleeveRole =
        panel.role === "left_sleeve" || panel.role === "right_sleeve" ? panel.role : null;
      try {
        const buffer =
          sleeveRole && frontPlane
            ? await buildSleeveBuffer(job, sleeveRole, sizing.width, sizing.height, target.dpi)
            : await cropExact(master, {
                ...crop,
                outWidth: sizing.width,
                outHeight: sizing.height,
                dpi: target.dpi
              });
        const { fileUrl, mockupUrl } = await this.hostWorkingBuffer(buffer, sizing.factor, transparent);
        // File-library mirroring is RETIRED from the run path: nothing consumes
        // it (orders/mockups use our URLs), and its print-res ingest saturated
        // Printful's per-store queue — mockup tasks sat 'pending' forever
        // behind it (the AOP-hoodie stall, proven by payload replay).
        return [
          {
            job_id: job.job_id,
            placement: job.placement,
            status: "success",
            generation_mode: "sliced",
            file_url: fileUrl,
            mockup_file_url: mockupUrl,
            file_type: "png",
            public_url: true,
            transparent_background: transparent,
            must_render_in_mockup: job.must_render_in_mockup !== false,
            source_job_id: job.source_job_id ?? null,
            source_parent_url: masterUrl,
            geometry_applied: true,
            notes:
              sleeveRole && frontPlane
                ? "Sleeve worn-view assembly: front-visible half continues the front print, back-visible half continues the back print (mirrored), hard centerline per garment construction."
                : "Cut from shared master at garment-plane rect; seam continuity guaranteed by shared cut lines."
          },
          {
            job_id: job.job_id,
            placement: job.placement,
            strategy: "master_slice",
            model: IMAGE.FLUX_2_FLEX,
            seed,
            prompt,
            plane_rect_in: { x: panel.xIn, y: panel.yIn, w: panel.widthIn, h: panel.heightIn },
            crop_px: {
              left: Math.round(crop.left),
              top: Math.round(crop.top),
              width: Math.round(crop.width),
              height: Math.round(crop.height)
            },
            tile_phase_px: null,
            upscale_factor: sizing.factor,
            target_px: { width: target.width, height: target.height },
            dpi: target.dpi,
            transparent,
            source_urls: masterUrl ? [masterUrl] : [],
            printful_file_id: null
          }
        ];
      } catch (error) {
        return { failure: `Slice failed: ${(error as Error).message}` };
      }
    };
    const SLICE_CONCURRENCY = 3;
    const sliceResults = new Array<Awaited<ReturnType<typeof sliceOne>>>(sliceJobs.length);
    let nextSlice = 0;
    await Promise.all(
      Array.from({ length: Math.min(SLICE_CONCURRENCY, sliceJobs.length) }, async () => {
        while (nextSlice < sliceJobs.length) {
          const index = nextSlice++;
          sliceResults[index] = await sliceOne(sliceJobs[index]);
        }
      })
    );
    sliceJobs.forEach((job, index) => {
      const outcome = sliceResults[index];
      if ("failure" in outcome) this.recordFailure(job, outcome.failure, record);
      else record(...outcome);
    });

    for (const job of directJobs) {
      await this.generateDirect(runId, job, design, masterUrl, record);
    }
    return masterUrl;
  }

  private async compilePatternTile(
    runId: string,
    jobs: CompileJob[],
    design: DesignSpec,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void,
    profile?: CalibrationProfile
  ): Promise<string | null> {
    const seed = stableSeed(runId, "pattern-tile");
    const prompt = tilePrompt(design);
    let tile: RasterImage;
    let tileUrl: string | null = null;
    try {
      const generated = await this.media.generateImage({
        model: IMAGE.FLUX_2_FLEX,
        positivePrompt: prompt,
        negativePrompt: negativeFor(design),
        width: 1024,
        height: 1024,
        seed,
        referenceImages: design.customer_image_urls?.length
          ? design.customer_image_urls.map((image) => ({ image }))
          : undefined
      });
      tileUrl = generated.imageURL;
      tile = await fetchImage(tileUrl);
    } catch (error) {
      for (const job of jobs) {
        this.recordFailure(job, `Pattern tile generation failed: ${(error as Error).message}`, record);
      }
      return tileUrl;
    }

    const plane = buildGarmentPlane(
      jobs.map((job) => ({
        placement: job.placement,
        width_px: job.geometry_contract?.width_px,
        height_px: job.geometry_contract?.height_px,
        dpi: job.geometry_contract?.dpi
      })),
      profile
    );
    const planeByPlacement = new Map(plane.panels.map((panel) => [panel.placement, panel]));
    /** Physical repeat: one tile spans this many inches of garment (bounded). */
    const rawTile = design.pattern_tile_inches;
    const TILE_INCHES =
      typeof rawTile === "number" && Number.isFinite(rawTile)
        ? Math.min(48, Math.max(1, rawTile))
        : 6;

    for (const job of jobs) {
      const panel = planeByPlacement.get(job.placement)!;
      const target = jobTarget(job);
      const sizing = workingSize(target.width, target.height);
      // Tile the full canvas window, phase-locked in garment space.
      const ppiWork = sizing.width / panel.canvasWIn;
      const tilePx = TILE_INCHES * ppiWork;
      const phase = { x: panel.canvasXIn * ppiWork, y: panel.canvasYIn * ppiWork };
      const transparent = wantsTransparency(job);
      try {
        const buffer = await tileExact(tile, {
          outWidth: sizing.width,
          outHeight: sizing.height,
          tileWidth: tilePx,
          tileHeight: tilePx,
          offsetX: phase.x,
          offsetY: phase.y,
          dpi: target.dpi
        });
        const { fileUrl, mockupUrl } = await this.hostWorkingBuffer(buffer, sizing.factor, transparent);
        const printfulRef = null as { id: number } | null; // mirror retired (starved mockup ingest)
        record(
          {
            job_id: job.job_id,
            placement: job.placement,
            status: "success",
            generation_mode: "repeated",
            file_url: fileUrl,
            mockup_file_url: mockupUrl,
            file_type: "png",
            public_url: true,
            transparent_background: transparent,
            must_render_in_mockup: job.must_render_in_mockup !== false,
            source_job_id: job.source_job_id ?? null,
            source_parent_url: tileUrl,
            geometry_applied: true,
            notes: `Phase-locked tiling from the shared seamless swatch (${TILE_INCHES}\" repeat); pattern aligns across seams by garment-space arithmetic.${
              printfulRef ? ` Mirrored to Printful file ${printfulRef.id}.` : ""
            }`
          },
          {
            job_id: job.job_id,
            placement: job.placement,
            strategy: "pattern_tile",
            model: IMAGE.FLUX_2_FLEX,
            seed,
            prompt,
            plane_rect_in: { x: panel.xIn, y: panel.yIn, w: panel.widthIn, h: panel.heightIn },
            crop_px: null,
            tile_phase_px: { x: Math.round(phase.x), y: Math.round(phase.y) },
            upscale_factor: sizing.factor,
            target_px: { width: target.width, height: target.height },
            dpi: target.dpi,
            transparent,
            source_urls: tileUrl ? [tileUrl] : [],
            printful_file_id: printfulRef?.id ?? null
          }
        );
      } catch (error) {
        this.recordFailure(job, `Tiling failed: ${(error as Error).message}`, record);
      }
    }
    return tileUrl;
  }

  /** Public single-job path (also used by the legacy tool contract). */
  async compileSingle(
    runId: string,
    job: CompileJob,
    design: DesignSpec,
    masterUrl: string | null = null
  ): Promise<{ panel: CompiledPanel; provenance: PanelProvenance }> {
    let captured: { panel: CompiledPanel; provenance: PanelProvenance } | null = null;
    await this.generateDirect(runId, job, design, masterUrl, (panel, prov) => {
      captured = { panel, provenance: prov };
    });
    return captured!;
  }

  private async generateDirect(
    runId: string,
    job: CompileJob,
    design: DesignSpec,
    masterUrl: string | null,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void
  ) {
    const target = jobTarget(job);
    const isLabel = job.worker_type === "label" || job.mapping_rule?.mode === "label_lockup";
    const seed = stableSeed(runId, job.job_id, job.placement);
    const prompt = job.prompt ?? panelPrompt(design, job);
    const transparent = wantsTransparency(job);

    const references: Array<{ image: string }> = [];
    const derives =
      job.design_action === "derive_from_master" ||
      job.design_action === "slice_from_master" ||
      job.mapping_rule?.mode === "continuation" ||
      job.mapping_rule?.mode === "edge_wrap";
    if (derives && masterUrl) references.push({ image: masterUrl });
    for (const url of design.customer_image_urls ?? []) {
      if (references.length < 10) references.push({ image: url });
    }

    // Model routing: labels/typography -> Recraft; transparent standalone art
    // -> FLUX.1 dev with NATIVE LayerDiffuse alpha (no background-removal
    // artifacts); everything else -> FLUX.2 flex. Reference-guided derivation
    // needs FLUX.2's multi-reference support, so it keeps the BiRefNet path.
    const nativeAlpha = transparent && !isLabel && !references.length;
    let model: string = isLabel ? IMAGE.RECRAFT_V4_1_PRO : IMAGE.FLUX_2_FLEX;
    if (nativeAlpha) model = IMAGE.FLUX_1_DEV;

    // Generation size: exact target aspect ratio within model bounds.
    const scale = Math.min(2048 / target.width, 2048 / target.height, 1);
    const genW = clampFluxDimension(target.width * scale);
    const genH = clampFluxDimension(target.height * scale);

    try {
      let generated;
      try {
        generated = await this.media.generateImage({
          model,
          positivePrompt: prompt,
          negativePrompt: negativeFor(design),
          width: genW,
          height: genH,
          seed,
          referenceImages: references.length ? references : undefined,
          ...(nativeAlpha ? { layerDiffuse: true } : {})
        });
      } catch (error) {
        if (!nativeAlpha) throw error;
        // Fall back to FLUX.2 + background removal if LayerDiffuse fails.
        model = IMAGE.FLUX_2_FLEX;
        generated = await this.media.generateImage({
          model,
          positivePrompt: prompt,
          negativePrompt: negativeFor(design),
          width: genW,
          height: genH,
          seed
        });
      }

      let fileUrl = generated.imageURL;
      const preUpscaleUrl = generated.imageURL;
      let factor: 2 | 4 | null = null;
      if (Math.max(target.width, target.height) > Math.max(genW, genH)) {
        const ratio = Math.max(target.width, target.height) / Math.max(genW, genH);
        factor = ratio <= 2 ? 2 : 4; // imageUpscale accepts 2 or 4, not 3
        const upscaled = await this.media.upscale(fileUrl, factor);
        fileUrl = upscaled.imageURL;
      }
      // Native LayerDiffuse alpha survives as-is; a BiRefNet pass is needed
      // when there is no native alpha, or when upscaling may have flattened it.
      const hasNativeAlpha = nativeAlpha && model === IMAGE.FLUX_1_DEV && factor === null;
      if (transparent && !hasNativeAlpha) {
        const cutout = await this.media.removeBackground(fileUrl);
        fileUrl = cutout.imageURL;
      }
      // Mockup copy: the pre-upscale generation is already <=2048px — exactly
      // what the mockup generator wants. Transparent panels keep the final
      // cutout (alpha must survive on the garment mockup).
      const mockupUrl = factor !== null && !transparent ? preUpscaleUrl : fileUrl;
      const printfulRef = null as { id: number } | null; // mirror retired (starved mockup ingest)

      record(
        {
          job_id: job.job_id,
          placement: job.placement,
          status: "success",
          generation_mode: derives ? "derived" : "generated",
          file_url: fileUrl,
          mockup_file_url: mockupUrl,
          file_type: "png",
          public_url: true,
          transparent_background: transparent,
          must_render_in_mockup: job.must_render_in_mockup !== false,
          source_job_id: job.source_job_id ?? null,
          source_parent_url: derives ? masterUrl : null,
          geometry_applied: true,
          notes: `Generated with ${model}${derives ? " using the master artwork as reference" : ""}.${
            printfulRef ? ` Mirrored to Printful file ${printfulRef.id}.` : ""
          }`
        },
        {
          job_id: job.job_id,
          placement: job.placement,
          strategy: derives ? "reference_derive" : "direct",
          model,
          seed,
          prompt,
          plane_rect_in: null,
          crop_px: null,
          tile_phase_px: null,
          upscale_factor: factor,
          target_px: { width: target.width, height: target.height },
          dpi: target.dpi,
          transparent,
          source_urls: [masterUrl, ...(design.customer_image_urls ?? [])].filter(
            (url): url is string => Boolean(url)
          ),
          printful_file_id: printfulRef?.id ?? null
        }
      );
    } catch (error) {
      this.recordFailure(job, `Generation failed: ${(error as Error).message}`, record);
    }
  }

  private async compileMirror(
    runId: string,
    job: CompileJob,
    panels: CompiledPanel[],
    record: (panel: CompiledPanel, prov: PanelProvenance) => void
  ) {
    const target = jobTarget(job);
    const source =
      panels.find((panel) => panel.job_id === job.source_job_id && panel.file_url) ??
      panels.find(
        (panel) =>
          panel.file_url &&
          classifyPlacement(panel.placement) ===
            (classifyPlacement(job.placement) === "left_sleeve" ? "right_sleeve" : "left_sleeve")
      );
    if (!source?.file_url) {
      this.recordFailure(job, "mirror_from_pair source panel has no file", record);
      return;
    }
    try {
      const sourceImage = await fetchImage(source.file_url);
      const mirrored = await mirrorHorizontal(sourceImage, target.dpi);
      const { fileUrl, mockupUrl } = await this.hostWorkingBuffer(mirrored, 2, false);
      const printfulRef = null as { id: number } | null; // mirror retired (starved mockup ingest)
      record(
        {
          job_id: job.job_id,
          placement: job.placement,
          status: "success",
          generation_mode: "mirrored",
          file_url: fileUrl,
          mockup_file_url: mockupUrl,
          file_type: "png",
          public_url: true,
          transparent_background: false,
          must_render_in_mockup: job.must_render_in_mockup !== false,
          source_job_id: source.job_id,
          source_parent_url: source.file_url,
          geometry_applied: true,
          notes: `Deterministic horizontal mirror of ${source.placement}.${
            printfulRef ? ` Mirrored to Printful file ${printfulRef.id}.` : ""
          }`
        },
        {
          job_id: job.job_id,
          placement: job.placement,
          strategy: "mirror",
          model: null,
          seed: null,
          prompt: null,
          plane_rect_in: null,
          crop_px: null,
          tile_phase_px: null,
          upscale_factor: 2,
          target_px: { width: target.width, height: target.height },
          dpi: target.dpi,
          transparent: false,
          source_urls: [source.file_url],
          printful_file_id: printfulRef?.id ?? null
        }
      );
    } catch (error) {
      this.recordFailure(job, `Mirror failed: ${(error as Error).message}`, record);
    }
  }

  private recordFailure(
    job: CompileJob,
    reason: string,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void
  ) {
    const target = jobTarget(job);
    record(
      {
        job_id: job.job_id,
        placement: job.placement,
        status: "failed",
        generation_mode: "generated",
        file_url: null,
        mockup_file_url: null,
        file_type: "none",
        public_url: false,
        transparent_background: false,
        must_render_in_mockup: job.must_render_in_mockup !== false,
        source_job_id: job.source_job_id ?? null,
        source_parent_url: null,
        geometry_applied: false,
        notes: reason
      },
      {
        job_id: job.job_id,
        placement: job.placement,
        strategy: "direct",
        model: null,
        seed: null,
        prompt: null,
        plane_rect_in: null,
        crop_px: null,
        tile_phase_px: null,
        upscale_factor: null,
        target_px: { width: target.width, height: target.height },
        dpi: target.dpi,
        transparent: false,
        source_urls: [],
        printful_file_id: null
      }
    );
  }
}
