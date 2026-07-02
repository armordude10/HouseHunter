/**
 * Live Panel Compiler test against the real Runware API.
 *
 * Runs three AOP garments end to end through the deterministic engine —
 * hoodie (5 panels), tee (4 panels), leggings (2 panels, pattern mode) —
 * downloads every generated file, and composes per-garment review images:
 *
 *   out/aop-test/<garment>-master.png   the single authored artwork
 *   out/aop-test/<garment>-strip.png    final panels laid edge-to-edge at a
 *                                       common physical scale so seam
 *                                       continuity is visible
 *   out/aop-test/<garment>-<panel>.png  each final print file
 *   out/aop-test/gallery.html           everything with captions
 *
 * Usage: RUNWARE_API_KEY=... npx tsx scripts/livetest.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { RunwareMedia } from "../src/runware/media.js";
import { PanelCompiler, CompileJob, DesignSpec } from "../src/engine/panelCompiler.js";
import { buildGarmentPlane } from "../src/engine/garmentSpace.js";

const OUT_DIR = path.resolve("out/aop-test");

interface GarmentCase {
  name: string;
  title: string;
  runId: string;
  design: DesignSpec;
  jobs: CompileJob[];
}

const job = (
  id: string,
  placement: string,
  widthPx: number,
  heightPx: number,
  designAction: string,
  workerType = "wrap"
): CompileJob => ({
  job_id: id,
  placement,
  worker_type: workerType,
  design_action: designAction,
  must_generate: true,
  must_render_in_mockup: true,
  geometry_contract: { width_px: widthPx, height_px: heightPx, dpi: 150 },
  output_contract: { transparent_background: false }
});

const CASES: GarmentCase[] = [
  {
    name: "hoodie",
    title: "AOP Hoodie — 5 panels (front, back, sleeves, hood), master-slice",
    runId: "live-aop-hoodie-1",
    design: {
      artwork_brief:
        "Bioluminescent koi fish swimming through deep indigo night water among glowing " +
        "lotus flowers and drifting light particles, painterly ukiyo-e influence",
      style_terms: ["ukiyo-e", "bioluminescent", "painterly"],
      palette: ["deep indigo", "teal glow", "warm coral accents"],
      mood_terms: ["serene", "mystical"]
    },
    jobs: [
      job("hoodie-front", "front", 2400, 2880, "slice_from_master"),
      job("hoodie-back", "back", 2400, 2880, "slice_from_master"),
      job("hoodie-ls", "left_sleeve", 1350, 2400, "slice_from_master"),
      job("hoodie-rs", "right_sleeve", 1350, 2400, "slice_from_master"),
      job("hoodie-hood", "hood", 2000, 1600, "slice_from_master")
    ]
  },
  {
    name: "tee",
    title: "AOP Tee — 4 panels (front, back, sleeves), master-slice",
    runId: "live-aop-tee-1",
    design: {
      artwork_brief:
        "Retro synthwave sunset over a chrome ocean horizon with palm silhouettes and a " +
        "wireframe grid foreground, continuous sky gradient",
      style_terms: ["synthwave", "retrowave", "1980s poster art"],
      palette: ["hot magenta", "sunset orange", "electric purple", "cyan"],
      mood_terms: ["nostalgic", "vibrant"]
    },
    jobs: [
      job("tee-front", "front", 2400, 2880, "slice_from_master"),
      job("tee-back", "back", 2400, 2880, "slice_from_master"),
      job("tee-ls", "left_sleeve", 1200, 1200, "slice_from_master"),
      job("tee-rs", "right_sleeve", 1200, 1200, "slice_from_master")
    ]
  },
  {
    name: "leggings",
    title: "AOP Leggings — 2 leg panels, phase-locked seamless pattern",
    runId: "live-aop-leggings-1",
    design: {
      artwork_brief:
        "Art deco peacock feather geometric pattern, interlocking fans and eye motifs " +
        "with fine gold linework on deep emerald",
      style_terms: ["art deco", "geometric", "luxury textile"],
      palette: ["deep emerald", "metallic gold", "midnight teal"],
      mood_terms: ["elegant", "opulent"]
    },
    jobs: [
      job("leg-left", "left_leg", 2400, 3600, "repeat_pattern", "pattern"),
      job("leg-right", "right_leg", 2400, 3600, "repeat_pattern", "pattern")
    ]
  }
];

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

const savePng = async (name: string, buffer: Buffer) => {
  const file = path.join(OUT_DIR, name);
  await writeFile(file, buffer);
  return file;
};

/** Panels laid edge-to-edge at one shared physical scale (px per inch). */
const composeStrip = async (
  garment: GarmentCase,
  files: Map<string, Buffer>
): Promise<Buffer> => {
  const plane = buildGarmentPlane(
    garment.jobs.map((j) => ({
      placement: j.placement,
      width_px: j.geometry_contract?.width_px,
      height_px: j.geometry_contract?.height_px,
      dpi: j.geometry_contract?.dpi
    }))
  );
  const panels = plane.panels
    .filter((p) => files.has(p.placement))
    .sort((a, b) => a.xIn - b.xIn || a.yIn - b.yIn);
  const displayPpi = 640 / Math.max(...panels.map((p) => p.yIn + p.heightIn));
  const canvasW = Math.ceil(Math.max(...panels.map((p) => (p.xIn + p.widthIn) * displayPpi)));
  const canvasH = Math.ceil(Math.max(...panels.map((p) => (p.yIn + p.heightIn) * displayPpi)));

  const overlays: sharp.OverlayOptions[] = [];
  for (const panel of panels) {
    const w = Math.max(1, Math.round(panel.widthIn * displayPpi));
    const h = Math.max(1, Math.round(panel.heightIn * displayPpi));
    const resized = await sharp(files.get(panel.placement)!).resize(w, h, { fit: "fill" }).png().toBuffer();
    overlays.push({
      input: resized,
      left: Math.round(panel.xIn * displayPpi),
      top: Math.round(panel.yIn * displayPpi)
    });
    const label = Buffer.from(
      `<svg width="${w}" height="28"><rect width="${w}" height="28" fill="black" fill-opacity="0.55"/>` +
        `<text x="8" y="19" font-family="sans-serif" font-size="14" fill="white">${panel.placement}</text></svg>`
    );
    overlays.push({
      input: label,
      left: Math.round(panel.xIn * displayPpi),
      top: Math.round(panel.yIn * displayPpi)
    });
  }
  return sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 24, g: 24, b: 28, alpha: 1 } }
  })
    .composite(overlays)
    .png()
    .toBuffer();
};

const thumb = async (buffer: Buffer, maxW: number) =>
  sharp(buffer).resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();

const b64 = (buffer: Buffer, mime = "image/jpeg") =>
  `data:${mime};base64,${buffer.toString("base64")}`;

const run = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const media = new RunwareMedia();
  const compiler = new PanelCompiler(media);
  const galleryBlocks: string[] = [];

  for (const garment of CASES) {
    console.log(`\n=== ${garment.title} ===`);
    const started = Date.now();
    const result = await compiler.compile(garment.runId, garment.jobs, garment.design);
    console.log(
      `strategy=${result.strategy} ok=${result.all_required_succeeded} ` +
        `missing=${JSON.stringify(result.missing_required_placements)} ` +
        `(${((Date.now() - started) / 1000).toFixed(1)}s)`
    );

    const files = new Map<string, Buffer>();
    for (const panel of result.panels) {
      if (panel.status === "success" && panel.file_url) {
        const buffer = await download(panel.file_url);
        files.set(panel.placement, buffer);
        const meta = await sharp(buffer).metadata();
        console.log(`  ${panel.placement}: ${meta.width}x${meta.height} ${panel.generation_mode}`);
        await savePng(`${garment.name}-${panel.placement}.png`, buffer);
      } else {
        console.log(`  ${panel.placement}: ${panel.status} — ${panel.notes}`);
      }
    }

    const sourceUrl = result.master_artwork_url ?? result.pattern_tile_url;
    let masterBuffer: Buffer | null = null;
    if (sourceUrl) {
      masterBuffer = await download(sourceUrl);
      await savePng(`${garment.name}-master.png`, masterBuffer);
    }
    let stripBuffer: Buffer | null = null;
    if (files.size) {
      stripBuffer = await composeStrip(garment, files);
      await savePng(`${garment.name}-strip.png`, stripBuffer);
    }

    const panelCells = await Promise.all(
      result.panels.map(async (panel) => {
        const buffer = files.get(panel.placement);
        const meta = buffer ? await sharp(buffer).metadata() : null;
        const img = buffer ? `<img src="${b64(await thumb(buffer, 340))}"/>` : "";
        return `<figure>${img}<figcaption><b>${panel.placement}</b> · ${panel.generation_mode} · ${
          meta ? `${meta.width}×${meta.height}px` : panel.status
        }</figcaption></figure>`;
      })
    );

    galleryBlocks.push(`
      <section>
        <h2>${garment.title}</h2>
        <p class="brief">${garment.design.artwork_brief}</p>
        <p class="meta">strategy: <b>${result.strategy}</b> · all required panels: <b>${
          result.all_required_succeeded ? "SUCCESS" : "INCOMPLETE"
        }</b> · missing: ${result.missing_required_placements.length}</p>
        ${
          masterBuffer
            ? `<h3>${result.strategy === "pattern_tile" ? "Seamless master swatch" : "Master composition (unwrapped garment plane)"}</h3>
               <img class="wide" src="${b64(await thumb(masterBuffer, 980))}"/>`
            : ""
        }
        ${
          stripBuffer
            ? `<h3>Final panels, laid edge-to-edge at true relative scale (seam check)</h3>
               <img class="wide" src="${b64(await thumb(stripBuffer, 980))}"/>`
            : ""
        }
        <h3>Individual print files</h3>
        <div class="grid">${panelCells.join("")}</div>
      </section>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Threadbot × Runware — AOP Panel Compiler live test</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background:#121216; color:#eaeaf0; margin:0; padding:32px; }
    h1 { font-size: 22px; } h2 { font-size: 18px; margin-top: 40px; border-top: 1px solid #2c2c34; padding-top: 24px; }
    h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color:#9a9ab0; margin: 18px 0 8px; }
    .brief { color:#c9c9d8; max-width: 70ch; } .meta { color:#8f8fa6; font-size: 13px; }
    img { border-radius: 8px; display:block; } img.wide { max-width: 100%; }
    .grid { display:flex; flex-wrap: wrap; gap: 14px; }
    figure { margin:0; } figcaption { font-size: 12px; color:#9a9ab0; margin-top: 6px; }
  </style></head><body>
  <h1>Threadbot × Runware — AOP Panel Compiler live test</h1>
  <p class="meta">One master artwork per garment, panels cut/tiled deterministically in garment space. Every file below is a real hosted Runware output downloaded and re-rendered locally.</p>
  ${galleryBlocks.join("\n")}
  </body></html>`;
  await writeFile(path.join(OUT_DIR, "gallery.html"), html);
  console.log(`\nWrote ${OUT_DIR}/gallery.html`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
