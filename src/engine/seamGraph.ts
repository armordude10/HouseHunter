/**
 * Measured seam graph — the ground truth of how Printful maps each placement
 * template onto the sewn garment, measured (not assumed) by printing numbered
 * calibration grids through the manufacturer's REAL mockup pipeline and
 * scanline-reading the photos (data/seam-graph.json carries provenance).
 *
 * Everything is expressed in "worn units" (wu): the calibration photo's
 * garment-scaled pixel frame. Each placement's template maps to wu by an
 * affine law per axis, wu = a * template_fraction + b. The worn-view painter
 * paints in this frame and slices each print file at its measured window, so
 * art crosses every seam at the right position AND the right physical scale
 * — including the two silent killers this measurement exposed:
 *   1. the back slice must be FLOPPED (painted back views are x-ray views);
 *   2. sleeve templates carry ~13.8% more px per inch than the body, and
 *      template x=0.5 sits exactly on the outer-arm fold.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AffineMap {
  /** wu = a * templateFraction + b */
  a: number;
  b: number;
}

export interface SeamSlice {
  view: "front" | "back";
  x: AffineMap;
  y: AffineMap;
  /** Crop must be mirrored after extraction (x-ray painted view -> garment). */
  flop: boolean;
}

export interface SeamSleeve {
  y: AffineMap;
  /** Which template x-range faces the viewer in the FRONT worn view. */
  frontHalf: [number, number];
  /** Paint-zone key carrying the visible sleeve rect. */
  zone: "sleeve_left" | "sleeve_right";
}

export interface WuRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SeamGraph {
  frame: WuRect & { x0: number; y0: number; x1: number; y1: number };
  body: WuRect;
  paint: Record<string, WuRect>;
  slices: Record<string, SeamSlice>;
  sleeves: Record<string, SeamSleeve>;
}

interface RawGraphFile {
  products: Record<string, any>;
}

let cache: RawGraphFile | null | undefined;

const loadFile = (): RawGraphFile | null => {
  if (cache !== undefined) return cache;
  const candidates = [
    resolve(process.cwd(), "data/seam-graph.json"),
    resolve(new URL(".", import.meta.url).pathname, "../../data/seam-graph.json")
  ];
  for (const path of candidates) {
    try {
      cache = JSON.parse(readFileSync(path, "utf8")) as RawGraphFile;
      return cache;
    } catch {
      // try next
    }
  }
  cache = null;
  return cache;
};

const affine = (pair: [number, number]): AffineMap => ({ a: pair[0], b: pair[1] });

/** Measured seam graph for a product, or null when uncalibrated. */
export const seamGraphFor = (productId: number | string | null | undefined): SeamGraph | null => {
  const file = loadFile();
  const raw = file?.products?.[String(productId ?? "")];
  if (!raw) return null;
  const rect = (r: any): WuRect => ({ left: r.left ?? r.x0, top: r.top ?? r.y0, right: r.right ?? r.x1, bottom: r.bottom ?? r.y1 });
  const slices: Record<string, SeamSlice> = {};
  for (const [key, s] of Object.entries<any>(raw.slices ?? {})) {
    slices[key] = { view: s.view, x: affine(s.x), y: affine(s.y), flop: Boolean(s.flop) };
  }
  const sleeves: Record<string, SeamSleeve> = {};
  for (const [key, s] of Object.entries<any>(raw.sleeves ?? {})) {
    sleeves[key] = { y: affine(s.y), frontHalf: s.front_half, zone: s.zone };
  }
  return {
    frame: { ...rect(raw.frame), x0: raw.frame.x0, y0: raw.frame.y0, x1: raw.frame.x1, y1: raw.frame.y1 },
    body: rect(raw.body),
    paint: Object.fromEntries(Object.entries<any>(raw.paint ?? {}).map(([k, v]) => [k, rect(v)])),
    slices,
    sleeves
  };
};
