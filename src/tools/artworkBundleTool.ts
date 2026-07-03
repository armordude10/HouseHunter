/**
 * Runware-backed implementation of the `generate_panel_artwork_bundle` tool.
 *
 * The Placement Bundle Compiler's instructions require this exact tool name
 * (formerly served by the hosted threadbot_artwork_mcp service). The tool
 * contract is preserved; the backing engine is the garment-space Panel
 * Compiler (src/engine/panelCompiler.ts) running on Runware.ai models.
 *
 * Design goals, mapped to Threadbot's historical failure modes:
 *
 *   - The tool accepts the FULL surface plan (surface_plan_json) and executes
 *     every placement job in one call: generated, sliced, tiled, mirrored,
 *     derived, or intentionally blank. The agent cannot under-iterate; a
 *     bundle with one filled panel and silently-missing others is
 *     structurally impossible. missing_required_placements is computed in
 *     code, not by the model.
 *
 *   - Multi-panel continuity is deterministic: one master composition (or
 *     one seamless swatch) authored on the shared garment plane, then cut or
 *     phase-locked-tiled into each panel at its exact geometry spec. A
 *     Gildan 5000 front-only plan collapses naturally to a single direct
 *     generation; an AOP crew neck (front/back/left_sleeve/right_sleeve)
 *     slices four spec-exact files from one canvas with shared cut lines.
 *
 *   - Every output is a real hosted public URL (Runware), optionally mirrored
 *     into Printful's File Library for durable print storage, and every panel
 *     carries a reproducible provenance record (model, seed, prompt, crop and
 *     tile math) — the "design genome".
 *
 * A legacy per-job mode (`jobs` parameter) is kept for callers that pass
 * individual placement jobs instead of the full plan.
 */

import { AgentTool } from "../runware/agent.js";
import { RunwareMedia } from "../runware/media.js";
import {
  CompileJob,
  DesignSpec,
  PanelCompiler
} from "../engine/panelCompiler.js";
import { getRunContext } from "../engine/runContext.js";
import { getCalibrationProfile } from "../engine/calibrationProfiles.js";

interface SurfacePlanShape {
  product_id?: number | string;
  placement_jobs?: Array<Record<string, unknown>>;
}

const toCompileJob = (raw: Record<string, unknown>): CompileJob => ({
  job_id: String(raw.job_id ?? raw.placement ?? "job"),
  placement: String(raw.placement ?? "front"),
  worker_type: raw.worker_type as string | undefined,
  design_action: raw.design_action as string | undefined,
  must_generate: raw.must_generate as boolean | undefined,
  must_render_in_mockup: raw.must_render_in_mockup as boolean | undefined,
  source_job_id: (raw.source_job_id as string | null | undefined) ?? null,
  prompt: raw.prompt as string | undefined,
  mapping_rule: raw.mapping_rule as CompileJob["mapping_rule"],
  geometry_contract: raw.geometry_contract as CompileJob["geometry_contract"],
  output_contract: raw.output_contract as CompileJob["output_contract"]
});

export const createGeneratePanelArtworkBundleTool = (
  media?: RunwareMedia
): AgentTool => ({
  name: "generate_panel_artwork_bundle",
  description:
    "Generate the COMPLETE panel artwork bundle for a surface plan in one call. " +
    "Pass surface_plan_json (the full surface plan) plus the design brief; the engine executes every " +
    "placement_job deterministically — master-slice or phase-locked pattern tiling for multi-panel " +
    "AOP garments (seam continuity guaranteed by shared garment-space cut lines), direct generation " +
    "for single-placement products and detached panels, deterministic mirroring for paired panels, " +
    "and explicit accounting of intentionally blank placements. Backed by Runware.ai models " +
    "(FLUX.2 flex, Recraft V4.1 Pro for label/typography lockups, BiRefNet transparency, print-res " +
    "upscaling). Returns one entry per job with real hosted public PNG URLs, code-computed " +
    "missing_required_placements, and a reproducible design genome. " +
    "Alternatively pass `jobs` to render individual placement jobs (legacy mode).",
  parameters: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "Pipeline run identifier (also seeds deterministic generation)." },
      surface_plan_json: {
        type: "string",
        description:
          "The complete surface_plan JSON (as produced by the Product-Surface Planner). " +
          "All placement_jobs inside it are executed in one call."
      },
      design: {
        type: "object",
        description: "Design program distilled for artwork generation.",
        properties: {
          artwork_brief: { type: "string", description: "Full artwork brief from the design program." },
          style_terms: { type: "array", items: { type: "string" } },
          palette: { type: "array", items: { type: "string" } },
          mood_terms: { type: "array", items: { type: "string" } },
          negative_constraints: { type: "array", items: { type: "string" } },
          required_text: { type: "array", items: { type: "string" } },
          forbidden_text: { type: "array", items: { type: "string" } },
          base_product_color: { type: "string" }
        },
        required: ["artwork_brief"]
      },
      jobs: {
        type: "array",
        description:
          "LEGACY MODE: individual placement jobs to render when surface_plan_json is not supplied.",
        items: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            placement: { type: "string" },
            worker_type: { type: "string" },
            design_action: { type: "string" },
            prompt: { type: "string" },
            width_px: { type: "number" },
            height_px: { type: "number" },
            dpi: { type: "number" },
            transparent_background: { type: "boolean" },
            master_artwork_url: { type: "string" },
            source_job_id: { type: "string" }
          },
          required: ["job_id", "placement", "prompt"]
        }
      }
    },
    required: ["run_id"]
  },
  execute: async (args) => {
    const runId = String(args.run_id ?? "run");
    const context = getRunContext(runId);
    // Lazy media construction: requiring credentials at module load would
    // crash any process that merely imports the workflow.
    const compiler = new PanelCompiler(media ?? new RunwareMedia());

    const designInput = (args.design as Partial<DesignSpec> | undefined) ?? {};
    const design: DesignSpec = {
      artwork_brief: designInput.artwork_brief ?? "",
      style_terms: designInput.style_terms,
      palette: designInput.palette,
      mood_terms: designInput.mood_terms,
      negative_constraints: designInput.negative_constraints,
      required_text: designInput.required_text,
      forbidden_text: designInput.forbidden_text,
      base_product_color: designInput.base_product_color,
      customer_image_urls: context?.customerImageUrls,
      customer_image_captions: context?.customerImageCaptions
    };

    // Preferred path: execute the entire surface plan in one deterministic pass.
    if (typeof args.surface_plan_json === "string" && args.surface_plan_json.length > 4_000_000) {
      return JSON.stringify({ error: "surface_plan_json exceeds the 4MB safety limit" });
    }
    if (typeof args.surface_plan_json === "string" && args.surface_plan_json.trim()) {
      let plan: SurfacePlanShape;
      try {
        plan = JSON.parse(args.surface_plan_json) as SurfacePlanShape;
      } catch (error) {
        return JSON.stringify({
          error: `surface_plan_json is not valid JSON: ${(error as Error).message}`
        });
      }
      const jobs = (plan.placement_jobs ?? []).map(toCompileJob);
      if (!jobs.length) {
        return JSON.stringify({ error: "surface_plan_json contains no placement_jobs" });
      }
      // Cost guard: no real product needs more panels than this; a plan that
      // does is malformed or hostile and must be fixed upstream, not billed.
      const MAX_JOBS = 40;
      if (jobs.length > MAX_JOBS) {
        return JSON.stringify({
          error: `surface plan contains ${jobs.length} placement_jobs, exceeding the ${MAX_JOBS}-job safety limit`
        });
      }
      const result = await compiler.compile(
        runId,
        jobs,
        design,
        getCalibrationProfile(plan.product_id)
      );
      return JSON.stringify({
        run_id: runId,
        provider: "runware",
        mode: "full_surface_plan",
        strategy: result.strategy,
        master_artwork_url: result.master_artwork_url,
        pattern_tile_url: result.pattern_tile_url,
        panels: result.panels,
        submitted_placement_files: result.panels
          .filter((panel) => panel.status === "success" && panel.file_url && panel.must_render_in_mockup)
          .map((panel) => ({ placement: panel.placement, file_url: panel.file_url })),
        missing_required_placements: result.missing_required_placements,
        all_required_succeeded: result.all_required_succeeded,
        design_genome: result.genome
      });
    }

    // Legacy mode: individual jobs.
    const legacyJobs = (args.jobs as Array<Record<string, unknown>> | undefined) ?? [];
    if (!legacyJobs.length) {
      return JSON.stringify({
        error: "Provide surface_plan_json (preferred) or a non-empty jobs array."
      });
    }
    const outputs = [];
    let masterUrl: string | null = null;
    for (const raw of legacyJobs) {
      const job = toCompileJob(raw);
      job.geometry_contract = {
        width_px: raw.width_px as number | undefined,
        height_px: raw.height_px as number | undefined,
        dpi: raw.dpi as number | undefined
      };
      job.output_contract = {
        transparent_background: raw.transparent_background as boolean | undefined
      };
      const jobMaster = (raw.master_artwork_url as string | undefined) ?? masterUrl;
      const { panel } = await compiler.compileSingle(runId, job, design, jobMaster);
      if (job.worker_type === "master" && panel.file_url && !masterUrl) {
        masterUrl = panel.file_url;
      }
      outputs.push(panel);
    }
    return JSON.stringify({
      run_id: runId,
      provider: "runware",
      mode: "legacy_jobs",
      master_artwork_url: masterUrl,
      panels: outputs,
      all_succeeded: outputs.every((panel) => panel.status === "success")
    });
  }
});
