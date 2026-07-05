/**
 * Intelligent garment-colour selection. Given the finished (transparent) design and the garment's
 * available colours, pick the shirt that pairs best:
 *   - legibility: strong luminance contrast so the art reads on the shirt,
 *   - harmony: colour-wheel relationship (a saturated design favours a complementary-hued shirt;
 *     neutral shirts are always a safe pairing).
 */
import sharp from "sharp";

export interface ColorOption {
  name: string;
  hex: string;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToHs(r: number, g: number, b: number): { h: number; s: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === R) h = ((G - B) / d) % 6;
    else if (mx === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Average luminance + dominant hue/saturation of a design's opaque pixels. */
export async function analyzeDesign(buf: Buffer): Promise<{ l: number; h: number; s: number } | null> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const N = info.width * info.height;
  let r = 0, g = 0, b = 0, n = 0;
  let hr = 0, hg = 0, hb = 0, hn = 0; // accent (saturated) pixels only, for hue
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3] < 128) continue; // skip transparent
    const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
    r += R; g += G; b += B; n++;
    if (Math.max(R, G, B) - Math.min(R, G, B) > 45) { hr += R; hg += G; hb += B; hn++; }
  }
  if (!n) return null;
  const l = luminance(r / n, g / n, b / n);
  const [HR, HG, HB] = hn ? [hr / hn, hg / hn, hb / hn] : [r / n, g / n, b / n];
  const { h, s } = rgbToHs(HR, HG, HB);
  return { l, h, s };
}

/** Choose the best-pairing garment colour name, or null if it can't be determined. */
export async function pickGarmentColor(buf: Buffer, colors: ColorOption[]): Promise<string | null> {
  const d = await analyzeDesign(buf);
  if (!d || !colors.length) return null;

  let best: string | null = null;
  let bestScore = -Infinity;
  for (const c of colors) {
    const rgb = hexToRgb(c.hex);
    if (!rgb) continue;
    const L = luminance(rgb[0], rgb[1], rgb[2]);
    const { h: H, s: S } = rgbToHs(rgb[0], rgb[1], rgb[2]);

    const legibility = Math.abs(L - d.l) / 255; // 0..1, higher = more readable
    let harmony: number;
    if (S < 0.18) harmony = 0.6;          // neutral shirt — always a safe pairing
    else if (d.s < 0.15) harmony = 0.25;  // neutral/greyscale design — a loud shirt is risky
    else harmony = hueDistance(H, d.h) / 180; // 1 at complementary, 0 at same hue

    const score = 0.6 * legibility + 0.4 * harmony;
    if (score > bestScore) { bestScore = score; best = c.name; }
  }
  return best;
}
