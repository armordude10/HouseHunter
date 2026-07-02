/**
 * Analytic Printful calibration.
 *
 * Printful's v2 mockup-templates endpoint exposes, per placement:
 *   - image_url: the template overlay PNG — opaque except where the print
 *     file shows through (the piece region is TRANSPARENT)
 *   - template_width/height and print_area_left/top/width/height: exactly
 *     where the print-file canvas maps within that template image
 *
 * From those two facts the piece-within-canvas mapping is computable exactly,
 * for every product in the catalog, with no manual measurement:
 *
 *   pieceRect(canvas fractions) = robustRect(transparent pixels) mapped
 *                                 through the print-area transform
 *
 * The robust rect uses per-row/per-column MEDIAN extents rather than the raw
 * bounding box, so curved cut edges (underarm corners, tapered sleeves) don't
 * inflate the dominant sew-line rectangle.
 *
 * Overlay anchors: placements that physically sit on another piece (pouch
 * pockets on fronts) share the same printfile canvas space; the anchor is the
 * difference of the two piece centers in canvas fractions.
 */

import { CalibrationProfile, PlacementCalibration, classifyPlacement } from "./garmentSpace.js";
import sharp from "sharp";

const PRINTFUL_API_BASE = process.env.PRINTFUL_API_BASE ?? "https://api.printful.com";

export interface MockupTemplateEntry {
  placement: string;
  technique: string;
  image_url: string;
  template_width: number;
  template_height: number;
  print_area_width: number;
  print_area_height: number;
  print_area_top: number;
  print_area_left: number;
  printfile_id: number | null;
  template_positioning: string;
}

const apiKey = () => {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY is not set");
  return key;
};

export const fetchMockupTemplates = async (
  productId: number
): Promise<MockupTemplateEntry[]> => {
  const response = await fetch(
    `${PRINTFUL_API_BASE}/v2/catalog-products/${productId}/mockup-templates?limit=100`,
    { headers: { Authorization: `Bearer ${apiKey()}` } }
  );
  if (response.status === 404) return [];
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    return fetchMockupTemplates(productId);
  }
  if (!response.ok) {
    throw new Error(`mockup-templates ${productId}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data?: MockupTemplateEntry[] };
  return body.data ?? [];
};

const median = (values: number[]): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export interface PieceDetection {
  pieceWFrac: number;
  pieceHFrac: number;
  pieceCxFrac: number;
  pieceCyFrac: number;
  transparentShare: number;
}

/**
 * Detect the piece rect (canvas fractions) from a template overlay image.
 * Returns null when the image carries no meaningful transparent region.
 */
export const detectPieceRect = async (
  imageBuffer: Buffer,
  template: Pick<
    MockupTemplateEntry,
    "template_width" | "print_area_left" | "print_area_top" | "print_area_width" | "print_area_height"
  >
): Promise<PieceDetection | null> => {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scale = info.width / template.template_width;

  const rowMin: number[] = [];
  const rowMax: number[] = [];
  const colMin: number[] = [];
  const colMax: number[] = [];
  const colFirst: number[] = new Array(info.width).fill(-1);
  const colLast: number[] = new Array(info.width).fill(-1);
  let transparent = 0;

  for (let y = 0; y < info.height; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (alpha < 128) {
        transparent++;
        if (first < 0) first = x;
        last = x;
        if (colFirst[x] < 0) colFirst[x] = y;
        colLast[x] = y;
      }
    }
    // Ignore slivers (antialiasing, drawstring holes).
    if (first >= 0 && last - first > info.width * 0.02) {
      rowMin.push(first);
      rowMax.push(last);
    }
  }
  for (let x = 0; x < info.width; x++) {
    if (colFirst[x] >= 0 && colLast[x] - colFirst[x] > info.height * 0.02) {
      colMin.push(colFirst[x]);
      colMax.push(colLast[x]);
    }
  }

  const share = transparent / (info.width * info.height);
  if (share < 0.01 || !rowMin.length || !colMin.length) return null;

  const x0 = median(rowMin);
  const x1 = median(rowMax);
  const y0 = median(colMin);
  const y1 = median(colMax);

  const paLeft = template.print_area_left * scale;
  const paTop = template.print_area_top * scale;
  const paW = template.print_area_width * scale;
  const paH = template.print_area_height * scale;

  const fx0 = (x0 - paLeft) / paW;
  const fx1 = (x1 - paLeft) / paW;
  const fy0 = (y0 - paTop) / paH;
  const fy1 = (y1 - paTop) / paH;

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const wFrac = clamp01(fx1) - clamp01(fx0);
  const hFrac = clamp01(fy1) - clamp01(fy0);
  if (wFrac <= 0.02 || hFrac <= 0.02) return null;

  return {
    pieceWFrac: Number(wFrac.toFixed(4)),
    pieceHFrac: Number(hFrac.toFixed(4)),
    pieceCxFrac: Number(((clamp01(fx0) + clamp01(fx1)) / 2).toFixed(4)),
    pieceCyFrac: Number(((clamp01(fy0) + clamp01(fy1)) / 2).toFixed(4)),
    transparentShare: Number(share.toFixed(4))
  };
};

/** Techniques whose print canvas maps 1:1 onto the visible print area. */
const SIMPLE_TECHNIQUES = new Set(["dtg", "dtfilm", "embroidery", "digital"]);

/**
 * Build the calibration profile for one product from Printful template truth.
 * Returns null when the product has no mockup templates (e.g. discontinued).
 */
export const buildProductCalibration = async (
  productId: number
): Promise<{ profile: CalibrationProfile; techniques: Set<string> } | null> => {
  const templates = await fetchMockupTemplates(productId);
  if (!templates.length) return null;

  // First template per placement (variant groups repeat placements).
  const byPlacement = new Map<string, MockupTemplateEntry>();
  for (const template of templates) {
    if (!byPlacement.has(template.placement)) byPlacement.set(template.placement, template);
  }

  const profile: CalibrationProfile = {};
  const techniques = new Set<string>();
  const imageCache = new Map<string, Buffer>();

  for (const [placement, template] of byPlacement) {
    techniques.add(template.technique);
    if (SIMPLE_TECHNIQUES.has(template.technique)) continue; // piece == canvas
    try {
      let image = imageCache.get(template.image_url);
      if (!image) {
        const response = await fetch(template.image_url);
        if (!response.ok) continue;
        image = Buffer.from(await response.arrayBuffer());
        imageCache.set(template.image_url, image);
      }
      const detection = await detectPieceRect(image, template);
      if (detection) {
        profile[placement] = {
          pieceWFrac: detection.pieceWFrac,
          pieceHFrac: detection.pieceHFrac,
          pieceCxFrac: detection.pieceCxFrac,
          pieceCyFrac: detection.pieceCyFrac
        };
      }
    } catch {
      // Leave placement uncalibrated (defaults to full canvas).
    }
  }

  // NOTE on overlay anchors: an empirical same-grid-to-front-and-pocket
  // mockup test (out/calibration/pocket-truth.jpg) proved that pocket
  // canvases are NOT anatomically co-aligned with front canvases — each
  // piece is roughly centered in its own canvas regardless of where it sits
  // on the garment. Anchors therefore cannot be derived from template
  // centers; the engine uses an empirical pouch-position default, with
  // per-product overrides in calibrationProfiles.ts.

  return { profile, techniques };
};
