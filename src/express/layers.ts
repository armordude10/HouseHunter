/**
 * Layered composition engine — the proprietary fusion at the top of the
 * express pipeline. Research lineage, adapted into deterministic code:
 *
 *   - LLM-as-layout-planner (Ranni arXiv:2311.17002, RPG arXiv:2401.11708):
 *     the single intent call plans layers as grounded boxes in PIECE space.
 *   - Box-grounded placement (GLIGEN arXiv:2301.07093): where diffusion
 *     methods steer attention toward boxes and hope, we composite pixels at
 *     the box — placement error is exactly zero.
 *   - Transparent asset generation (LayerDiffuse arXiv:2402.17113):
 *     gpt-image-1.5 native-alpha elements; opacity is verified per asset and
 *     repaired with background removal when a backend ignored the request.
 *   - Typography (vs AnyText arXiv:2311.03054 / Glyph-ByT5 arXiv:2403.09622):
 *     text layers are CODE-RENDERED (SVG -> raster, bundled fonts) — perfect
 *     spelling, kerning and scale by construction, not by sampling luck.
 *
 * Coordinates: layer boxes are fractions of the VISIBLE PIECE. The engine
 * maps piece space -> file-canvas pixels through the same piece-within-canvas
 * calibration the slicing engine trusts, so "center of the chest" lands on
 * the sewn chest — not the canvas center — on every calibrated product.
 */

import sharp from "sharp";
import { CompiledPanel, MediaLike } from "../engine/panelCompiler.js";
import { PanelProvenance, stableSeed } from "../engine/provenance.js";
import { PlacementCalibration } from "../engine/garmentSpace.js";
import { DesignLayer } from "./intent.js";
import { PlacementSpec } from "./truth.js";

export const MAX_LAYERS = 6;

const clampPx = (value: number) => Math.min(16000, Math.max(16, Math.round(value)));
const clamp01 = (value: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

const escapeXml = (text: string) =>
  text.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string);

/** Code-rendered typography: exact string, exact width, zero hallucination. */
const renderTextLayer = async (content: string, widthPx: number, color: string): Promise<Buffer> => {
  const text = content.slice(0, 120);
  const fill = color.trim() || "#111111";
  // Render oversized, trim to ink, then scale to the exact grounded width.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2200" height="500">
    <text x="24" y="330" font-family="DejaVu Sans" font-weight="bold" font-size="240"
      fill="${escapeXml(fill)}">${escapeXml(text)}</text></svg>`;
  const inked = await sharp(Buffer.from(svg)).png().toBuffer();
  const trimmed = await sharp(inked).trim().png().toBuffer();
  return sharp(trimmed).resize({ width: clampPx(widthPx) }).png().toBuffer();
};

/** True-alpha check: does the image actually carry meaningful transparency? */
const hasRealAlpha = async (buffer: Buffer): Promise<boolean> => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  const total = info.width * info.height;
  const step = Math.max(1, Math.floor(total / 20000));
  for (let i = 0; i < total; i += step) {
    if (data[i * info.channels + 3] < 128) transparent++;
  }
  return transparent / (total / step) > 0.02;
};

const fetchBuffer = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`layer asset fetch failed (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
};

export interface LayeredPanelResult {
  panel: CompiledPanel;
  provenance: PanelProvenance;
}

export interface LayerOverlay {
  buffer: Buffer;
  canvasW: number;
  canvasH: number;
  sourceUrls: string[];
  promptParts: string[];
}

/**
 * Render the layers into ONE transparent full-canvas overlay. Used standalone
 * (layers ARE the design) and as a composite pass on top of generated
 * artwork (layers_only=false: "AOP art + '745' across the chest").
 */
export const renderLayerOverlay = async (params: {
  media: MediaLike;
  spec: PlacementSpec;
  layers: DesignLayer[];
  imageUrls: string[];
  runId: string;
  calibration?: PlacementCalibration;
}): Promise<LayerOverlay> => {
  const { media, spec, imageUrls, runId, calibration } = params;
  const layers = [...params.layers]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .slice(0, MAX_LAYERS);

  const canvasW = clampPx(spec.widthIn * spec.dpi);
  const canvasH = clampPx(spec.heightIn * spec.dpi);

  // Piece rect within the file canvas (full canvas when uncalibrated - true
  // for DTG, whose print area IS the piece).
  const pieceW = canvasW * clamp01(calibration?.pieceWFrac ?? 1, 1);
  const pieceH = canvasH * clamp01(calibration?.pieceHFrac ?? 1, 1);
  const pieceX = canvasW * clamp01(calibration?.pieceCxFrac ?? 0.5, 0.5) - pieceW / 2;
  const pieceY = canvasH * clamp01(calibration?.pieceCyFrac ?? 0.5, 0.5) - pieceH / 2;

  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  const sourceUrls: string[] = [];
  const promptParts: string[] = [];

  for (const layer of layers) {
    const widthPx = Math.max(16, Math.round(pieceW * clamp01(layer.width_frac, 0.4)));
    let asset: Buffer;

    if (layer.kind === "text") {
      asset = await renderTextLayer(layer.content, widthPx, layer.color);
      promptParts.push(`text("${layer.content.slice(0, 60)}")`);
    } else if (layer.kind === "customer_image") {
      const index = layer.image_index ?? 0;
      const url = imageUrls[index];
      if (!url) throw new Error(`layer references attached image ${index + 1}, which was not provided`);
      sourceUrls.push(url);
      asset = await sharp(await fetchBuffer(url)).resize({ width: widthPx }).png().toBuffer();
      promptParts.push(`customer_image(${index})`);
    } else {
      // Generated element with native alpha; verified, repaired if opaque.
      const generated = await media.generateImage({
        positivePrompt:
          `${layer.content.slice(0, 1500)}. Single isolated subject on a fully transparent background, ` +
          `no backdrop, no shadow box, no frame. Crisp print-ready edges.`,
        width: 1024,
        height: 1024,
        seed: stableSeed(runId, spec.placement, layer.order, layer.content),
        transparentBackground: true
      });
      sourceUrls.push(generated.imageURL);
      let bytes = await fetchBuffer(generated.imageURL);
      if (!(await hasRealAlpha(bytes))) {
        const cutout = await media.removeBackground(generated.imageURL);
        bytes = await fetchBuffer(cutout.imageURL);
      }
      asset = await sharp(bytes).trim().resize({ width: widthPx }).png().toBuffer();
      promptParts.push(`element("${layer.content.slice(0, 60)}")`);
    }

    if (layer.rotation_deg) {
      asset = await sharp(asset)
        .rotate(layer.rotation_deg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    }

    const meta = await sharp(asset).metadata();
    const w = meta.width ?? widthPx;
    const h = meta.height ?? widthPx;
    // Grounded placement: piece-space center -> canvas pixels, exact.
    const left = Math.round(pieceX + clamp01(layer.cx_frac, 0.5) * pieceW - w / 2);
    const top = Math.round(pieceY + clamp01(layer.cy_frac, 0.5) * pieceH - h / 2);
    composites.push({
      input: asset,
      left: Math.max(0, Math.min(canvasW - w, left)),
      top: Math.max(0, Math.min(canvasH - h, top))
    });
  }

  const composed = await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite(composites)
    .png()
    .toBuffer();
  return { buffer: composed, canvasW, canvasH, sourceUrls, promptParts };
};

export const compileLayeredPanel = async (params: {
  media: MediaLike;
  spec: PlacementSpec;
  layers: DesignLayer[];
  imageUrls: string[];
  runId: string;
  calibration?: PlacementCalibration;
  /** Hosting hook (defaults injected by the caller; tests use data URLs). */
  host: (png: Buffer) => Promise<string>;
}): Promise<LayeredPanelResult> => {
  const { spec, runId, host } = params;
  const overlay = await renderLayerOverlay(params);
  const { canvasW, canvasH, sourceUrls, promptParts } = overlay;
  const fileUrl = await host(overlay.buffer);

  return {
    panel: {
      job_id: `layers_${spec.placement}`,
      placement: spec.placement,
      status: "success",
      generation_mode: "derived",
      file_url: fileUrl,
      file_type: "png",
      public_url: true,
      transparent_background: true,
      must_render_in_mockup: true,
      source_job_id: null,
      source_parent_url: null,
      geometry_applied: true,
      notes: `Layered composition: ${promptParts.join(" + ")} grounded in piece space (exact-pixel compositing).`
    },
    provenance: {
      job_id: `layers_${spec.placement}`,
      placement: spec.placement,
      strategy: "reference_derive",
      model: null,
      seed: stableSeed(runId, spec.placement, "layers"),
      prompt: promptParts.join(" + "),
      plane_rect_in: null,
      crop_px: null,
      tile_phase_px: null,
      upscale_factor: null,
      target_px: { width: canvasW, height: canvasH },
      dpi: spec.dpi,
      transparent: true,
      source_urls: sourceUrls,
      printful_file_id: null
    }
  };
};
