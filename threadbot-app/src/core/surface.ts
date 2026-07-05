/**
 * Surface / panel intelligence.
 *
 * A product is a set of panels (front/back/sleeves/yoke/...). For all-over products we
 * build a GUARANTEED-seamless tile from the master design and apply it to EVERY panel
 * at ONE consistent physical scale (inches per motif). That gives cross-seam continuity
 * (every panel is the same pattern at the same size) and resolution independence
 * (tiling a crisp unit stays sharp at full printfile size).
 */

import sharp from "sharp";

export type DesignMode = "all_over" | "graphic" | "embroidery";

export interface Panel {
  placement: string;
  width: number;
  height: number;
  dpi: number;
}

const NON_DESIGN = /label|tag|inside|outside/i;

export function classifyMode(technique: string): DesignMode {
  const t = technique.toLowerCase();
  if (t === "cut-sew" || t === "sublimation" || t === "aop") return "all_over";
  if (t === "embroidery") return "embroidery";
  return "graphic";
}

export function selectDesignPanels(panels: Panel[], mode: DesignMode): Panel[] {
  const real = panels.filter((p) => !NON_DESIGN.test(p.placement));
  if (mode === "all_over") return real.length ? real : panels.slice(0, 1);
  const front =
    real.find((p) => /^front$/i.test(p.placement)) ??
    real.find((p) => /front/i.test(p.placement)) ??
    real[0];
  return front ? [front] : panels.slice(0, 1);
}

/**
 * Turn any image into a perfectly tileable unit via 2x2 mirroring: every edge mirrors
 * its neighbor, so repeats meet with no seam. Works for organic art (florals, koi,
 * galaxies) without looking obviously mirrored at normal density.
 */
export async function makeSeamless(master: Buffer, unitPx = 1024): Promise<Buffer> {
  const u = await sharp(master).resize(unitPx, unitPx, { fit: "cover" }).removeAlpha().toBuffer();
  const h = Math.floor(unitPx / 2);
  const ext = (l: number, t: number, w: number, ht: number) =>
    sharp(u).extract({ left: l, top: t, width: w, height: ht }).toBuffer();
  const [tl, tr, bl, br] = await Promise.all([
    ext(0, 0, h, h),
    ext(h, 0, unitPx - h, h),
    ext(0, h, h, unitPx - h),
    ext(h, h, unitPx - h, unitPx - h),
  ]);
  // 50% roll: swap diagonal quadrants so the OUTER edges become seamless (no mirror
  // symmetry); the only discontinuity is the original edges, now a center cross.
  const rolled = await sharp({ create: { width: unitPx, height: unitPx, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([
      { input: br, left: 0, top: 0 },
      { input: bl, left: unitPx - h, top: 0 },
      { input: tr, left: 0, top: unitPx - h },
      { input: tl, left: unitPx - h, top: unitPx - h },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
  // Heal that center cross with a feathered blend of a blurred copy.
  const band = Math.round(unitPx * 0.08);
  const blurAmt = Math.max(2, Math.round(unitPx * 0.015));
  const crossMask = await sharp(
    Buffer.from(
      `<svg width="${unitPx}" height="${unitPx}"><g filter="url(#b)">` +
        `<rect x="${h - band}" y="0" width="${band * 2}" height="${unitPx}" fill="#fff"/>` +
        `<rect x="0" y="${h - band}" width="${unitPx}" height="${band * 2}" fill="#fff"/></g>` +
        `<defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${band / 2}"/></filter></defs></svg>`
    )
  )
    .png()
    .toBuffer();
  const seamPatch = await sharp(rolled)
    .blur(blurAmt)
    .ensureAlpha()
    .composite([{ input: crossMask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return sharp(rolled).composite([{ input: seamPatch, blend: "over" }]).removeAlpha().png().toBuffer();
}

/** One scale for the whole garment so every panel renders at the same inches-per-pixel. */
export function panelScale(panels: Panel[], maxDim = 4000): number {
  const biggest = Math.max(...panels.map((p) => Math.max(p.width, p.height)));
  return Math.min(1, maxDim / biggest);
}

/** Fill a panel by tiling the seamless unit at a fixed pixel size (consistent scale). */
export async function tileFill(
  seamless: Buffer,
  panel: Panel,
  scale: number,
  tileInches = 26
): Promise<Buffer> {
  const W = Math.max(1, Math.round(panel.width * scale));
  const H = Math.max(1, Math.round(panel.height * scale));
  const tilePx = Math.max(64, Math.round(tileInches * (panel.dpi || 150) * scale));
  const tile = await sharp(seamless).resize(tilePx, tilePx, { fit: "fill" }).png().toBuffer();
  // Tile onto a canvas padded up to whole tiles (so tiles never overflow), then crop.
  const padW = Math.ceil(W / tilePx) * tilePx;
  const padH = Math.ceil(H / tilePx) * tilePx;
  const composites: sharp.OverlayOptions[] = [];
  for (let y = 0; y < padH; y += tilePx) for (let x = 0; x < padW; x += tilePx) composites.push({ input: tile, left: x, top: y });
  const tiled = await sharp({ create: { width: padW, height: padH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(composites)
    .png()
    .toBuffer();
  return sharp(tiled).extract({ left: 0, top: 0, width: W, height: H }).jpeg({ quality: 92 }).toBuffer();
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * SCENE mode: slice ONE coherent master across panels so a single design wraps the
 * garment. The hero/front takes the center; sleeves slice from the sides; the back
 * mirrors the center; the yoke takes the top — all at ONE consistent scale, so the
 * scene continues across panels instead of repeating.
 */
export async function sliceSceneToPanels(master: Buffer, panels: Panel[], scale: number): Promise<Map<string, Buffer>> {
  const dims = panels.map((p) => ({
    p,
    w: Math.max(1, Math.round(p.width * scale)),
    h: Math.max(1, Math.round(p.height * scale)),
  }));
  const maxW = Math.max(...dims.map((d) => d.w));
  const maxH = Math.max(...dims.map((d) => d.h));
  const canvasW = Math.round(maxW * 2.0);
  const canvasH = Math.round(maxH * 1.3);
  const canvas = await sharp(master).resize(canvasW, canvasH, { fit: "cover" }).toBuffer();
  const cx = canvasW / 2;
  const cy = canvasH / 2;

  const out = new Map<string, Buffer>();
  for (const { p, w, h } of dims) {
    const n = p.placement.toLowerCase();
    let left = Math.round(cx - w / 2);
    let top = Math.round(cy - h / 2);
    let flip = false;
    if (n.includes("sleeve") && n.includes("left")) left = Math.round(cx - maxW * 0.55 - w);
    else if (n.includes("sleeve") && n.includes("right")) { left = Math.round(cx + maxW * 0.55); flip = true; }
    else if (n.includes("yoke") || n.includes("collar")) top = 0;
    else if (n.includes("back")) flip = true;
    left = clamp(left, 0, canvasW - w);
    top = clamp(top, 0, canvasH - h);
    let region = sharp(canvas).extract({ left, top, width: w, height: h });
    if (flip) region = region.flop();
    out.set(p.placement, await region.jpeg({ quality: 92 }).toBuffer());
  }
  return out;
}

/** Single-panel / graphic fallback: cover-fit the master to one panel. */
export async function coverToPanel(master: Buffer, width: number, height: number, maxDim = 1800): Promise<Buffer> {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  return sharp(master)
    .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { fit: "cover" })
    .jpeg({ quality: 92 })
    .toBuffer();
}
