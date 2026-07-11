/**
 * Local mockup simulation on Printful's own template geometry.
 *
 * data/printful-templates.json (ingested from the v1 mockup-generator API)
 * stores, per product placement: the template overlay PNG — a real garment
 * flat with the print window TRANSPARENT — and the exact print-area rect in
 * template space. Compositing the compiled artwork BEHIND that overlay
 * reproduces what Printful's generator will render, locally, instantly and
 * free: the design shows through the garment-shaped window with the safe-
 * area guides on top.
 *
 * Purpose: give the pipeline EYES before money is spent. The simulated
 * sheet feeds the vision critic (src/express/critic.ts) and is hosted into
 * the run trace so a human can see exactly what was about to ship.
 */

import sharp from "sharp";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface TemplatePlacement {
  template_id: number;
  image_url: string | null;
  background_url: string | null;
  template_width: number;
  template_height: number;
  print_area_width: number;
  print_area_height: number;
  print_area_left: number;
  print_area_top: number;
  printfile_id: number | string | null;
  orientation: string | null;
}

interface TemplateDoc {
  min_dpi: number | null;
  conflicting_placements: string[];
  placements: Record<string, TemplatePlacement>;
}

let TEMPLATES: Record<string, TemplateDoc> | null = null;

const loadTemplates = (): Record<string, TemplateDoc> => {
  if (TEMPLATES) return TEMPLATES;
  for (const file of [
    path.resolve(process.cwd(), "data/printful-templates.json"),
    new URL("../../data/printful-templates.json", import.meta.url).pathname
  ]) {
    try {
      TEMPLATES = (JSON.parse(readFileSync(file, "utf8")) as { products: Record<string, TemplateDoc> })
        .products;
      return TEMPLATES;
    } catch {
      // try next location
    }
  }
  TEMPLATES = {};
  return TEMPLATES;
};

export const templateFor = (productId: number, placement: string): TemplatePlacement | null =>
  loadTemplates()[String(productId)]?.placements?.[placement] ?? null;

/** Template CDN requires a browser UA; results cached in-process. */
const overlayCache = new Map<string, Buffer>();
const fetchOverlay = async (url: string): Promise<Buffer | null> => {
  const hit = overlayCache.get(url);
  if (hit) return hit;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      }
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    overlayCache.set(url, bytes);
    if (overlayCache.size > 120) overlayCache.delete(overlayCache.keys().next().value as string);
    return bytes;
  } catch {
    return null;
  }
};

const fetchArt = async (url: string): Promise<Buffer> => {
  if (url.startsWith("data:")) return Buffer.from(url.replace(/^data:[^,]*,/, ""), "base64");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`sim art fetch HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** Simulate ONE placement: artwork under the template overlay. ~outWidth px. */
export const simulatePlacement = async (
  productId: number,
  placement: string,
  artUrl: string,
  outWidth = 640
): Promise<Buffer | null> => {
  const tpl = templateFor(productId, placement);
  if (!tpl?.image_url || !tpl.template_width || !tpl.template_height) return null;
  const overlayRaw = await fetchOverlay(tpl.image_url);
  if (!overlayRaw) return null;

  const scale = outWidth / tpl.template_width;
  const W = Math.max(64, Math.round(tpl.template_width * scale));
  const H = Math.max(64, Math.round(tpl.template_height * scale));
  // Print-area rect in scaled template space; may exceed template bounds
  // (Printful uses negative offsets for bleed) — the canvas clips it.
  const rect = {
    left: Math.round(tpl.print_area_left * scale),
    top: Math.round(tpl.print_area_top * scale),
    width: Math.max(8, Math.round(tpl.print_area_width * scale)),
    height: Math.max(8, Math.round(tpl.print_area_height * scale))
  };

  try {
    const art = await sharp(await fetchArt(artUrl))
      .resize(rect.width, rect.height, { fit: "fill" })
      .png()
      .toBuffer();
    const overlay = await sharp(overlayRaw).resize(W, H, { fit: "fill" }).ensureAlpha().png().toBuffer();
    // Neutral studio grey behind everything so transparent art edges and the
    // window read clearly; art behind the overlay (shows through the window).
    const artLeft = Math.max(0, rect.left);
    const artTop = Math.max(0, rect.top);
    const cropX = artLeft - rect.left;
    const cropY = artTop - rect.top;
    const cropW = Math.min(rect.width - cropX, W - artLeft);
    const cropH = Math.min(rect.height - cropY, H - artTop);
    if (cropW < 8 || cropH < 8) return null;
    const artClipped =
      cropX || cropY || cropW !== rect.width || cropH !== rect.height
        ? await sharp(art).extract({ left: cropX, top: cropY, width: cropW, height: cropH }).png().toBuffer()
        : art;
    return await sharp({ create: { width: W, height: H, channels: 3, background: { r: 228, g: 228, b: 230 } } })
      .composite([
        { input: artClipped, left: artLeft, top: artTop },
        { input: overlay, left: 0, top: 0 }
      ])
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    return null;
  }
};

/**
 * Simulate the whole run: every renderable panel through its template,
 * joined into ONE contact sheet (2-across grid) for the vision critic.
 */
export const simulateRun = async (
  productId: number,
  panels: Array<{ placement: string; file_url: string | null }>,
  outWidth = 640
): Promise<{ sheet: Buffer; simulated: string[] } | null> => {
  const tiles: Array<{ placement: string; buf: Buffer }> = [];
  for (const panel of panels) {
    if (!panel.file_url || /label/i.test(panel.placement)) continue;
    const buf = await simulatePlacement(productId, panel.placement, panel.file_url, outWidth);
    if (buf) tiles.push({ placement: panel.placement, buf });
    if (tiles.length >= 6) break; // critic legibility > completeness
  }
  if (!tiles.length) return null;
  const metas = await Promise.all(tiles.map((t) => sharp(t.buf).metadata()));
  const tileW = outWidth;
  const tileH = Math.max(...metas.map((m) => m.height ?? outWidth));
  const cols = tiles.length > 1 ? 2 : 1;
  const rows = Math.ceil(tiles.length / cols);
  const label = (text: string, w: number) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="28">` +
        `<rect width="${w}" height="28" fill="#111"/>` +
        `<text x="8" y="20" font-family="Arial" font-size="16" fill="#fff">${text}</text></svg>`
    );
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let i = 0; i < tiles.length; i++) {
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * (tileH + 28);
    composites.push({ input: tiles[i].buf, left: x, top: y + 28 });
    composites.push({ input: await sharp(label(tiles[i].placement, tileW)).png().toBuffer(), left: x, top: y });
  }
  const sheet = await sharp({
    create: {
      width: cols * tileW,
      height: rows * (tileH + 28),
      channels: 3,
      background: { r: 20, g: 20, b: 22 }
    }
  })
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
  return { sheet, simulated: tiles.map((t) => t.placement) };
};
