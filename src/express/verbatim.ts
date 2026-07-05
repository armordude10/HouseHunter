/**
 * Verbatim artwork path: the customer's uploaded image IS the print file.
 *
 * "Apply it exactly how I uploaded it" costs ZERO generations: fetch, honor
 * an optional background-removal directive, fit onto the placement's print
 * canvas without cropping or distortion (transparent letterbox), and host at
 * print resolution. Pixel-faithful by construction — no model ever sees it.
 */

import sharp from "sharp";
import { CompiledPanel, MediaLike } from "../engine/panelCompiler.js";
import { PanelProvenance } from "../engine/provenance.js";
import { PlacementSpec } from "./truth.js";

const clampPx = (value: number) => Math.min(16000, Math.max(16, Math.round(value)));

export const buildVerbatimPanel = async (
  media: MediaLike,
  spec: PlacementSpec,
  imageUrl: string,
  removeBackground: boolean
): Promise<{ panel: CompiledPanel; provenance: PanelProvenance }> => {
  const targetW = clampPx(spec.widthIn * spec.dpi);
  const targetH = clampPx(spec.heightIn * spec.dpi);

  let sourceUrl = imageUrl;
  if (removeBackground) {
    sourceUrl = (await media.removeBackground(imageUrl)).imageURL;
  }
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`could not fetch customer image (HTTP ${response.status})`);
  const source = Buffer.from(await response.arrayBuffer());

  // Fit inside the print canvas at half size, then use the hosting upscale
  // (x2) to land exactly on target — same working-size flow as the compiler.
  const working = await sharp(source)
    .resize(Math.ceil(targetW / 2), Math.ceil(targetH / 2), {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();
  const uploaded = await media.uploadImage(`data:image/png;base64,${working.toString("base64")}`);
  const hosted = await media.upscale(uploaded, 2);

  return {
    panel: {
      job_id: `verbatim_${spec.placement}`,
      placement: spec.placement,
      status: "success",
      generation_mode: "derived",
      file_url: hosted.imageURL,
      file_type: "png",
      public_url: true,
      transparent_background: true,
      must_render_in_mockup: true,
      source_job_id: null,
      source_parent_url: imageUrl,
      geometry_applied: true,
      notes: `Customer artwork applied verbatim${removeBackground ? " with background removed" : ""}; no generative changes.`
    },
    provenance: {
      job_id: `verbatim_${spec.placement}`,
      placement: spec.placement,
      strategy: "reference_derive",
      model: null,
      seed: null,
      prompt: null,
      plane_rect_in: null,
      crop_px: null,
      tile_phase_px: null,
      upscale_factor: 2,
      target_px: { width: targetW, height: targetH },
      dpi: spec.dpi,
      transparent: true,
      source_urls: [imageUrl],
      printful_file_id: null
    }
  };
};
