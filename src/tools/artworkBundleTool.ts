/**
 * Runware-backed implementation of the `generate_panel_artwork_bundle` tool.
 *
 * The Placement Bundle Compiler's instructions require this exact tool name
 * (formerly served by the hosted threadbot_artwork_mcp service). The tool
 * contract is preserved; the backing engine is now the Runware.ai platform:
 *
 *   - Hero / master / side / detail / wrap / overlay panels:
 *       FLUX.2 [flex] (bfl:6@1) - stable layouts, precise text placement,
 *       instruction editing with up to 10 reference images.
 *   - Label lockups and typography-led panels:
 *       Recraft V4.1 Pro (recraft:v4.1-pro@0) - best-in-class text/logo/icon
 *       rendering for apparel labels.
 *   - derive_from_master / slice_from_master / mirror_from_pair / continuation:
 *       FLUX.2 [flex] with the master artwork attached as a reference image.
 *   - repeat_pattern:
 *       FLUX.2 [flex] prompted for a seamless tileable repeat.
 *   - Transparent backgrounds (required by the placement output contract):
 *       BiRefNet General (runware:112@5) via removeBackground -> PNG.
 *
 * Every returned file_url is a real hosted public URL from Runware
 * (im.runware.ai), satisfying the pipeline invariant that required
 * generated/renderable placements must have real public file URLs.
 */

import { AgentTool } from "../runware/agent.js";
import { RunwareMedia, clampFluxDimension } from "../runware/media.js";
import { IMAGE } from "../runware/models.js";

interface PanelJobInput {
  job_id: string;
  placement: string;
  worker_type?: string;
  design_action?: string;
  prompt: string;
  negative_prompt?: string;
  width_px?: number;
  height_px?: number;
  transparent_background?: boolean;
  master_artwork_url?: string | null;
  reference_urls?: string[];
  mapping_mode?: string;
  seed?: number;
}

interface PanelJobOutput {
  job_id: string;
  placement: string;
  status: "success" | "failed";
  file_url: string | null;
  file_type: "png";
  public_url: boolean;
  transparent_background: boolean;
  model_used: string;
  notes: string;
}

const DEFAULT_SIZE = 1536;

const pickModel = (job: PanelJobInput): string => {
  if (job.worker_type === "label" || job.mapping_mode === "label_lockup") {
    return IMAGE.RECRAFT_V4_1_PRO;
  }
  return IMAGE.FLUX_2_FLEX;
};

const buildPrompt = (job: PanelJobInput): string => {
  const fragments = [job.prompt];
  if (job.design_action === "repeat_pattern" || job.mapping_mode === "pattern_tile") {
    fragments.push(
      "seamless tileable repeating pattern, edges align perfectly for tiling, no border, flat print-ready artwork"
    );
  }
  if (job.design_action === "mirror_from_pair" || job.mapping_mode === "mirror") {
    fragments.push("mirrored counterpart of the reference artwork, horizontally flipped composition");
  }
  if (job.mapping_mode === "continuation" || job.mapping_mode === "edge_wrap") {
    fragments.push(
      "artwork continues seamlessly from the reference image across the shared garment seam edge"
    );
  }
  if (job.transparent_background) {
    fragments.push("isolated artwork on a plain solid background, no scene, no garment, no mockup");
  }
  fragments.push("high resolution print-ready apparel graphic");
  return fragments.join(", ");
};

export const createGeneratePanelArtworkBundleTool = (
  media: RunwareMedia = new RunwareMedia()
): AgentTool => ({
  name: "generate_panel_artwork_bundle",
  description:
    "Generate, derive, slice, repeat, or mirror print-ready panel artwork files for a set of placement jobs. " +
    "Backed by Runware.ai image models (FLUX.2 flex for panels/derivation, Recraft V4.1 Pro for label/typography " +
    "lockups, BiRefNet for transparent PNG output). Returns a bundle with a real hosted public PNG URL per job.",
  parameters: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "Pipeline run identifier." },
      jobs: {
        type: "array",
        description: "Placement jobs to render. One artwork file is produced per job.",
        items: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            placement: { type: "string" },
            worker_type: {
              type: "string",
              description:
                "master | hero | overlay | wrap | side | detail | embroidery | label | pattern"
            },
            design_action: {
              type: "string",
              description:
                "generate_unique_art | derive_from_master | slice_from_master | repeat_pattern | mirror_from_pair"
            },
            prompt: {
              type: "string",
              description: "Full artwork brief for this placement, including style, palette and constraints."
            },
            negative_prompt: { type: "string" },
            width_px: { type: "number" },
            height_px: { type: "number" },
            transparent_background: { type: "boolean" },
            master_artwork_url: {
              type: "string",
              description: "Master artwork URL to derive/slice/mirror/continue from."
            },
            reference_urls: {
              type: "array",
              items: { type: "string" },
              description: "Additional reference image URLs (up to 10 total)."
            },
            mapping_mode: { type: "string" },
            seed: { type: "number" }
          },
          required: ["job_id", "placement", "prompt"]
        }
      }
    },
    required: ["jobs"]
  },
  execute: async (args) => {
    const jobs = (args.jobs as PanelJobInput[]) ?? [];
    const results: PanelJobOutput[] = [];
    let masterArtworkUrl: string | null = null;

    for (const job of jobs) {
      const model = pickModel(job);
      const wantsTransparency = job.transparent_background !== false;
      try {
        const references: Array<{ image: string }> = [];
        const masterRef = job.master_artwork_url ?? masterArtworkUrl;
        const derivesFromMaster =
          job.design_action === "derive_from_master" ||
          job.design_action === "slice_from_master" ||
          job.design_action === "mirror_from_pair" ||
          job.mapping_mode === "continuation" ||
          job.mapping_mode === "edge_wrap";
        if (derivesFromMaster && masterRef) {
          references.push({ image: masterRef });
        }
        for (const url of job.reference_urls ?? []) {
          if (references.length < 10) references.push({ image: url });
        }

        const generated = await media.generateImage({
          model,
          positivePrompt: buildPrompt(job),
          negativePrompt: job.negative_prompt,
          width: clampFluxDimension(job.width_px ?? DEFAULT_SIZE),
          height: clampFluxDimension(job.height_px ?? DEFAULT_SIZE),
          referenceImages: references.length ? references : undefined,
          seed: job.seed
        });

        let fileUrl = generated.imageURL;
        if (wantsTransparency) {
          const cutout = await media.removeBackground(fileUrl);
          fileUrl = cutout.imageURL;
        }

        if (job.worker_type === "master" && !masterArtworkUrl) {
          masterArtworkUrl = fileUrl;
        }

        results.push({
          job_id: job.job_id,
          placement: job.placement,
          status: "success",
          file_url: fileUrl,
          file_type: "png",
          public_url: true,
          transparent_background: wantsTransparency,
          model_used: model,
          notes: `Generated with ${model} on Runware${
            wantsTransparency ? "; background removed with BiRefNet General" : ""
          }.`
        });
      } catch (error) {
        results.push({
          job_id: job.job_id,
          placement: job.placement,
          status: "failed",
          file_url: null,
          file_type: "png",
          public_url: false,
          transparent_background: wantsTransparency,
          model_used: model,
          notes: `Generation failed: ${(error as Error).message}`
        });
      }
    }

    return JSON.stringify({
      run_id: args.run_id ?? null,
      master_artwork_url: masterArtworkUrl,
      jobs: results,
      provider: "runware",
      all_succeeded: results.every((job) => job.status === "success")
    });
  }
});
