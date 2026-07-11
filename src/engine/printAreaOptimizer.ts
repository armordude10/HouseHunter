/**
 * Print-area coverage optimizer — Threadbot's proprietary framing math.
 *
 * Problem: assets (logos, lockups, verbatim uploads, cutout art) arrive with
 * arbitrary dead margin around their real subject, so naive contain-fitting
 * prints postage stamps and wastes the print-safe area (live incidents).
 *
 * Method, deterministic end to end:
 *  1. SALIENT RECT — the subject's true bounding box:
 *     - transparent assets: robust alpha extents (per-row/column alpha mass,
 *       1st/99th percentile bounds — single stray pixels can't inflate it);
 *     - opaque assets: border-color deviation energy per row/column, same
 *       robust percentile extents (the technique lineage is salient-object
 *       reduction à la BiRefNet [arXiv:2401.03407], collapsed to the only
 *       question framing needs: WHERE is the subject).
 *  2. MAXIMAL-COVERAGE SOLVE — closed form: the largest scale s* mapping the
 *     salient rect into the safe rect with margin m is
 *       s* = min(safeW·(1−2m)/salW, safeH·(1−2m)/salH),
 *     centered by the salient rect's centroid (GLIGEN-style deterministic
 *     box grounding [arXiv:2301.07093] — exact pixels, not attention hopes).
 *  3. RE-FRAME — the asset is cropped to its salient rect (plus breathing
 *     border) and emitted at the solved size, reporting achieved coverage.
 */

import sharp from "sharp";

export interface SalientRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Fraction of asset area the subject occupies before optimization. */
  density: number;
}

const percentileExtent = (mass: number[], lo = 0.01, hi = 0.99): [number, number] => {
  const total = mass.reduce((a, b) => a + b, 0);
  if (total <= 0) return [0, mass.length - 1];
  let acc = 0;
  let start = 0;
  let end = mass.length - 1;
  for (let i = 0; i < mass.length; i++) {
    acc += mass[i];
    if (acc >= total * lo) { start = i; break; }
  }
  acc = 0;
  for (let i = mass.length - 1; i >= 0; i--) {
    acc += mass[i];
    if (acc >= total * (1 - hi)) { end = i; break; }
  }
  return end > start ? [start, end] : [0, mass.length - 1];
};

/** Locate the subject. Works on transparent AND opaque assets. */
export const salientRect = async (buffer: Buffer): Promise<SalientRect> => {
  const probe = await sharp(buffer)
    .resize(160, 160, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = probe;
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const rows = new Array<number>(H).fill(0);
  const cols = new Array<number>(W).fill(0);
  // Border median color = the background hypothesis for opaque assets.
  const border: number[][] = [];
  for (let x = 0; x < W; x++) {
    border.push([data[x * ch], data[x * ch + 1], data[x * ch + 2]]);
    const j = ((H - 1) * W + x) * ch;
    border.push([data[j], data[j + 1], data[j + 2]]);
  }
  const med = (k: number) => border.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(border.length / 2)];
  const bg = [med(0), med(1), med(2)];
  let alphaMass = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const a = data[i + 3];
      alphaMass += a < 250 ? 1 : 0;
      // Energy: transparency-aware subject mass; for opaque pixels, distance
      // from the border background color.
      const e =
        a < 128
          ? 0
          : Math.min(
              255,
              Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])
            ) * (a / 255);
      if (e > 24) { rows[y] += e; cols[x] += e; }
    }
  }
  const hasAlpha = alphaMass / (W * H) > 0.02;
  if (hasAlpha) {
    // Alpha mass IS the subject for cutouts — recompute on alpha alone.
    rows.fill(0); cols.fill(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * ch + 3];
      if (a > 32) { rows[y] += a; cols[x] += a; }
    }
  }
  const [y0, y1] = percentileExtent(rows);
  const [x0, x1] = percentileExtent(cols);
  const meta = await sharp(buffer).metadata();
  const sx = (meta.width ?? W) / W;
  const sy = (meta.height ?? H) / H;
  const rect = {
    left: Math.max(0, Math.floor(x0 * sx)),
    top: Math.max(0, Math.floor(y0 * sy)),
    width: Math.max(8, Math.ceil((x1 - x0 + 1) * sx)),
    height: Math.max(8, Math.ceil((y1 - y0 + 1) * sy))
  };
  const density = (rect.width * rect.height) / (((meta.width ?? W) * (meta.height ?? H)) || 1);
  return { ...rect, density };
};

/**
 * Re-frame an asset so its SUBJECT fills the target box maximally (margin m
 * on each side), preserving aspect. Returns the framed PNG + the achieved
 * subject coverage of the target area.
 */
export const maximizeCoverage = async (
  buffer: Buffer,
  targetW: number,
  targetH: number,
  margin = 0.05
): Promise<{ buffer: Buffer; coverage: number; salient: SalientRect }> => {
  const salient = await salientRect(buffer);
  const meta = await sharp(buffer).metadata();
  const W = meta.width ?? targetW;
  const H = meta.height ?? targetH;
  // Breathing border around the subject (8% of its size), clamped to asset.
  const pad = Math.round(Math.max(salient.width, salient.height) * 0.08);
  const crop = {
    left: Math.max(0, salient.left - pad),
    top: Math.max(0, salient.top - pad),
    width: Math.min(W - Math.max(0, salient.left - pad), salient.width + 2 * pad),
    height: Math.min(H - Math.max(0, salient.top - pad), salient.height + 2 * pad)
  };
  const inner = { w: Math.round(targetW * (1 - 2 * margin)), h: Math.round(targetH * (1 - 2 * margin)) };
  const framed = await sharp(buffer)
    .extract(crop)
    .resize(inner.w, inner.h, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const fm = await sharp(framed).metadata();
  const out = await sharp({
    create: { width: targetW, height: targetH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{
      input: framed,
      left: Math.round((targetW - (fm.width ?? inner.w)) / 2),
      top: Math.round((targetH - (fm.height ?? inner.h)) / 2)
    }])
    .png()
    .toBuffer();
  const coverage = ((fm.width ?? inner.w) * (fm.height ?? inner.h)) / (targetW * targetH);
  return { buffer: out, coverage, salient };
};
