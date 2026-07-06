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
  classifyPlacement
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
  customer_image_urls?: string[];
  customer_image_captions?: string[];
  /** Physical repeat size for pattern strategies ("statement" ~12-16, "micro" ~3-4). */
  pattern_tile_inches?: number;
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
const masterPrompt = (design: DesignSpec): string =>
  `One single continuous mural artwork filling the entire canvas edge to edge. ` +
  `${designCore(design)}. ` +
  `The scene flows uninterrupted across the whole canvas: no borders, no frames, no straight dividing lines, ` +
  `no outlines, no diagrams, no split composition, no text. ` +
  `Evenly distributed organic composition; important subjects spread across the middle of the canvas ` +
  `and kept away from all edges. Flat print-ready textile artwork, rich detail, cohesive color and lighting.`;

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

    if (strategy === "pattern_tile") {
      tileUrl = await this.compilePatternTile(runId, primaryJobs, design, record, profile);
    } else if (strategy === "master_slice") {
      masterUrl = await this.compileMasterSlice(runId, primaryJobs, design, record, profile);
    } else {
      for (const job of primaryJobs) {
        await this.generateDirect(runId, job, design, null, record);
      }
    }

    for (const job of mirrorJobs) {
      await this.compileMirror(runId, job, panels, record);
    }

    const missing = computeMissingRequired(jobs, panels);
    const genome: DesignGenome = {
      version: "threadbot-genome/1",
      run_id: runId,
      strategy,
      master_artwork_url: masterUrl,
      pattern_tile_url: tileUrl,
      panels: provenance
    };
    return {
      strategy,
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
    const prompt = masterPrompt(design);

    let master: RasterImage;
    let masterUrl: string | null = null;
    try {
      const generated = await this.media.generateImage({
        model: IMAGE.FLUX_2_FLEX,
        positivePrompt: prompt,
        negativePrompt: negativeFor(design),
        width: masterW,
        height: masterH,
        seed,
        referenceImages: design.customer_image_urls?.length
          ? design.customer_image_urls.map((image) => ({ image }))
          : undefined
      });
      masterUrl = generated.imageURL;
      master = await fetchImage(masterUrl);
    } catch (error) {
      for (const job of jobs) {
        this.recordFailure(job, `Master generation failed: ${(error as Error).message}`, record);
      }
      return masterUrl;
    }

    // Panels are independent once the master exists: slice/upscale/host them
    // CONCURRENTLY (an AOP hoodie is 6-7 panels of 6000px work — serial was
    // the "clocked forever" hot path). Results record in job order so bundles
    // stay deterministic. The Printful file-library mirror is fire-and-forget:
    // mockups and orders both consume our hosted URLs, never the mirror.
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
      try {
        const buffer = await cropExact(master, {
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
            notes: "Cut from shared master at garment-plane rect; seam continuity guaranteed by shared cut lines."
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
