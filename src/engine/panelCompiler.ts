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

import { clampFluxDimension } from "../runware/media.js";
import { IMAGE } from "../runware/models.js";
import {
  buildGarmentPlane,
  classifyPlacement,
  GarmentPlane,
  PanelPlan
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
import { mirrorToPrintfulFileLibrary, printfulEnabled } from "../integrations/printful.js";

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
  }): Promise<{ imageURL: string }>;
  removeBackground(imageUrl: string): Promise<{ imageURL: string }>;
  upscale(image: string, factor: 2 | 3 | 4): Promise<{ imageURL: string }>;
  uploadImage(image: string): Promise<string>;
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

const joinTerms = (terms?: string[]) => (terms?.length ? terms.join(", ") : "");

const designCore = (design: DesignSpec): string => {
  const parts = [design.artwork_brief];
  const style = joinTerms(design.style_terms);
  if (style) parts.push(`style: ${style}`);
  const palette = joinTerms(design.palette);
  if (palette) parts.push(`palette: ${palette}`);
  const mood = joinTerms(design.mood_terms);
  if (mood) parts.push(`mood: ${mood}`);
  if (design.required_text?.length) {
    parts.push(`must include the exact text: ${design.required_text.map((t) => `"${t}"`).join(", ")}`);
  }
  if (design.customer_image_captions?.length) {
    parts.push(`faithful to customer reference imagery: ${design.customer_image_captions.join("; ")}`);
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

const masterPrompt = (design: DesignSpec, plane: GarmentPlane, seamJobs: PanelPlan[]): string => {
  const regions = seamJobs
    .map((panel) => {
      const x0 = Math.round((panel.xIn / plane.widthIn) * 100);
      const x1 = Math.round(((panel.xIn + panel.widthIn) / plane.widthIn) * 100);
      return `${panel.placement} occupies ${x0}%-${x1}% of the width`;
    })
    .join("; ");
  return (
    `One single continuous artwork composition spanning the full canvas edge to edge, ` +
    `designed as the unwrapped surface of a garment (${regions}). ` +
    `The composition must flow uninterrupted across the entire canvas with no borders, ` +
    `no dividing lines, no framing, and important focal elements kept away from the far left and right edges. ` +
    `${designCore(design)}. Flat print-ready textile artwork, full bleed, high detail.`
  );
};

const tilePrompt = (design: DesignSpec): string =>
  `Seamless repeating textile pattern swatch, edges wrap perfectly for infinite tiling in all directions, ` +
  `uniform density, no border, no vignette. ${designCore(design)}. Flat print-ready pattern.`;

const panelPrompt = (design: DesignSpec, job: CompileJob): string => {
  const role = job.worker_type ?? classifyPlacement(job.placement);
  const anchor = job.mapping_rule?.anchor ? `, anchored ${job.mapping_rule.anchor}` : "";
  return (
    `${designCore(design)}. Artwork for the ${job.placement} placement of a garment ` +
    `(${role} panel${anchor}). Flat print-ready apparel graphic, high detail.`
  );
};

// -----------------------------------------------------------------------------
// Sizing math.
// -----------------------------------------------------------------------------

/**
 * Pick the working (pre-upscale) size and upscale factor for a target spec.
 * Working output stays within generation/upload-friendly bounds; the final
 * upscaled result meets or exceeds the target at the exact aspect ratio.
 */
export const workingSize = (targetW: number, targetH: number) => {
  const maxDim = Math.max(targetW, targetH);
  const factor = Math.min(4, Math.max(2, Math.ceil(maxDim / 2048))) as 2 | 3 | 4;
  return {
    factor,
    width: Math.max(16, Math.ceil(targetW / factor)),
    height: Math.max(16, Math.ceil(targetH / factor))
  };
};

const jobTarget = (job: CompileJob) => {
  const dpi = numberOr(job.geometry_contract?.dpi, 150);
  return {
    width: Math.round(numberOr(job.geometry_contract?.width_px, 12 * dpi)),
    height: Math.round(numberOr(job.geometry_contract?.height_px, 16 * dpi)),
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

  async compile(runId: string, jobs: CompileJob[], design: DesignSpec): Promise<CompileResult> {
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
      tileUrl = await this.compilePatternTile(runId, primaryJobs, design, record);
    } else if (strategy === "master_slice") {
      masterUrl = await this.compileMasterSlice(runId, primaryJobs, design, record);
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

  /** Locally-produced pixels -> hosted public URL at >= print spec. */
  private async hostWorkingBuffer(
    buffer: Buffer,
    factor: 2 | 3 | 4,
    transparent: boolean
  ): Promise<string> {
    const uuid = await this.media.uploadImage(toBase64Png(buffer));
    const upscaled = await this.media.upscale(uuid, factor);
    if (!transparent) return upscaled.imageURL;
    const cutout = await this.media.removeBackground(upscaled.imageURL);
    return cutout.imageURL;
  }

  private async compileMasterSlice(
    runId: string,
    jobs: CompileJob[],
    design: DesignSpec,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void
  ): Promise<string | null> {
    const plane = buildGarmentPlane(
      jobs.map((job) => ({
        placement: job.placement,
        width_px: job.geometry_contract?.width_px,
        height_px: job.geometry_contract?.height_px,
        dpi: job.geometry_contract?.dpi
      }))
    );
    const planeByPlacement = new Map(plane.panels.map((panel) => [panel.placement, panel]));
    const sliceJobs = jobs.filter((job) => planeByPlacement.get(job.placement)?.seamBound);
    const directJobs = jobs.filter((job) => !planeByPlacement.get(job.placement)?.seamBound);

    // Master canvas: the seam-bound bounding box rendered at the largest
    // resolution the generator supports, exact aspect ratio preserved.
    const bound = sliceJobs
      .map((job) => planeByPlacement.get(job.placement)!)
      .reduce(
        (acc, panel) => ({
          x0: Math.min(acc.x0, panel.xIn),
          y0: Math.min(acc.y0, panel.yIn),
          x1: Math.max(acc.x1, panel.xIn + panel.widthIn),
          y1: Math.max(acc.y1, panel.yIn + panel.heightIn)
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
    const prompt = masterPrompt(
      design,
      plane,
      sliceJobs.map((job) => planeByPlacement.get(job.placement)!)
    );

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

    for (const job of sliceJobs) {
      const panel = planeByPlacement.get(job.placement)!;
      const target = jobTarget(job);
      const sizing = workingSize(target.width, target.height);
      const crop = {
        left: (panel.xIn - bound.x0) * pxPerIn.x,
        top: (panel.yIn - bound.y0) * pxPerIn.y,
        width: panel.widthIn * pxPerIn.x,
        height: panel.heightIn * pxPerIn.y
      };
      const transparent = wantsTransparency(job);
      try {
        const buffer = await cropExact(master, {
          ...crop,
          outWidth: sizing.width,
          outHeight: sizing.height,
          dpi: target.dpi
        });
        const fileUrl = await this.hostWorkingBuffer(buffer, sizing.factor, transparent);
        const printfulRef = printfulEnabled()
          ? await mirrorToPrintfulFileLibrary(fileUrl, `${runId}-${job.placement}.png`)
          : null;
        record(
          {
            job_id: job.job_id,
            placement: job.placement,
            status: "success",
            generation_mode: "sliced",
            file_url: fileUrl,
            file_type: "png",
            public_url: true,
            transparent_background: transparent,
            must_render_in_mockup: job.must_render_in_mockup !== false,
            source_job_id: job.source_job_id ?? null,
            source_parent_url: masterUrl,
            geometry_applied: true,
            notes: `Cut from shared master at garment-plane rect; seam continuity guaranteed by shared cut lines.${
              printfulRef ? ` Mirrored to Printful file ${printfulRef.id}.` : ""
            }`
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
            printful_file_id: printfulRef?.id ?? null
          }
        );
      } catch (error) {
        this.recordFailure(job, `Slice failed: ${(error as Error).message}`, record);
      }
    }

    for (const job of directJobs) {
      await this.generateDirect(runId, job, design, masterUrl, record);
    }
    return masterUrl;
  }

  private async compilePatternTile(
    runId: string,
    jobs: CompileJob[],
    design: DesignSpec,
    record: (panel: CompiledPanel, prov: PanelProvenance) => void
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
      }))
    );
    const planeByPlacement = new Map(plane.panels.map((panel) => [panel.placement, panel]));
    /** Physical repeat: one tile spans this many inches of garment. */
    const TILE_INCHES = 6;

    for (const job of jobs) {
      const panel = planeByPlacement.get(job.placement)!;
      const target = jobTarget(job);
      const sizing = workingSize(target.width, target.height);
      const ppiWork = sizing.width / panel.widthIn;
      const tilePx = TILE_INCHES * ppiWork;
      const phase = { x: panel.xIn * ppiWork, y: panel.yIn * ppiWork };
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
        const fileUrl = await this.hostWorkingBuffer(buffer, sizing.factor, transparent);
        const printfulRef = printfulEnabled()
          ? await mirrorToPrintfulFileLibrary(fileUrl, `${runId}-${job.placement}.png`)
          : null;
        record(
          {
            job_id: job.job_id,
            placement: job.placement,
            status: "success",
            generation_mode: "repeated",
            file_url: fileUrl,
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
    const model = isLabel ? IMAGE.RECRAFT_V4_1_PRO : IMAGE.FLUX_2_FLEX;
    const seed = stableSeed(runId, job.job_id, job.placement);
    const prompt = job.prompt ?? panelPrompt(design, job);
    const transparent = wantsTransparency(job);

    // Generation size: exact target aspect ratio within model bounds.
    const scale = Math.min(2048 / target.width, 2048 / target.height, 1);
    const genW = clampFluxDimension(target.width * scale);
    const genH = clampFluxDimension(target.height * scale);

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

    try {
      const generated = await this.media.generateImage({
        model,
        positivePrompt: prompt,
        negativePrompt: negativeFor(design),
        width: genW,
        height: genH,
        seed,
        referenceImages: references.length ? references : undefined
      });

      let fileUrl = generated.imageURL;
      let factor: 2 | 3 | 4 | null = null;
      if (Math.max(target.width, target.height) > Math.max(genW, genH)) {
        factor = Math.min(
          4,
          Math.max(2, Math.ceil(Math.max(target.width, target.height) / Math.max(genW, genH)))
        ) as 2 | 3 | 4;
        const upscaled = await this.media.upscale(fileUrl, factor);
        fileUrl = upscaled.imageURL;
      }
      if (transparent) {
        const cutout = await this.media.removeBackground(fileUrl);
        fileUrl = cutout.imageURL;
      }
      const printfulRef = printfulEnabled()
        ? await mirrorToPrintfulFileLibrary(fileUrl, `${runId}-${job.placement}.png`)
        : null;

      record(
        {
          job_id: job.job_id,
          placement: job.placement,
          status: "success",
          generation_mode: derives ? "derived" : "generated",
          file_url: fileUrl,
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
      const fileUrl = await this.hostWorkingBuffer(mirrored, 2, false);
      const printfulRef = printfulEnabled()
        ? await mirrorToPrintfulFileLibrary(fileUrl, `${runId}-${job.placement}.png`)
        : null;
      record(
        {
          job_id: job.job_id,
          placement: job.placement,
          status: "success",
          generation_mode: "mirrored",
          file_url: fileUrl,
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
