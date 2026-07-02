/**
 * Demo: AOP Athletic Shoes (657), AOP Unisex Bomber Jacket (390), and
 * AOP Backpack (279) — calibrated panel compilation on Runware, official
 * Printful mockups as final outputs.
 *
 * Usage: RUNWARE_API_KEY=... npx tsx scripts/demo3.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { RunwareMedia } from "../src/runware/media.js";
import { createAndWaitForMockups } from "../src/integrations/printfulMockups.js";
import { PanelCompiler, CompileJob, DesignSpec } from "../src/engine/panelCompiler.js";
import { getCalibrationProfile } from "../src/engine/calibrationProfiles.js";

const OUT_DIR = path.resolve("out/demo3");

interface DemoCase {
  name: string;
  title: string;
  runId: string;
  productId: number;
  variantId: number;
  styleIds: number[];
  /** Printful technique per placement (from mockup-styles). */
  technique: string;
  /** Required product options (lowercase values), when the product has them. */
  productOptions?: Record<string, string>;
  design: DesignSpec;
  jobs: CompileJob[];
}

const job = (
  id: string,
  placement: string,
  widthIn: number,
  heightIn: number,
  designAction: string,
  workerType = "wrap"
): CompileJob => ({
  job_id: id,
  placement,
  worker_type: workerType,
  design_action: designAction,
  must_generate: true,
  must_render_in_mockup: true,
  geometry_contract: { width_px: Math.round(widthIn * 150), height_px: Math.round(heightIn * 150), dpi: 150 },
  output_contract: { transparent_background: false }
});

const CASES: DemoCase[] = [
  {
    name: "shoes",
    title: "AOP Men's Athletic Shoes (Printful #657)",
    runId: "demo-shoes-1",
    productId: 657,
    variantId: 20866,
    styleIds: [4934, 4939],
    technique: "sublimation",
    design: {
      artwork_brief:
        "Iridescent oil-slick marble flow with electric cyan, magenta and gold veins on deep black, " +
        "liquid chrome ripples and fine neon splatter",
      style_terms: ["holographic", "liquid marble", "streetwear"],
      palette: ["deep black", "electric cyan", "magenta", "gold"],
      pattern_tile_inches: 8
    },
    jobs: [
      job("shoe-left", "shoe_left", 13, 22, "repeat_pattern", "pattern"),
      job("shoe-right", "shoe_right", 13, 22, "repeat_pattern", "pattern")
    ]
  },
  {
    name: "bomber",
    title: "AOP Unisex Bomber Jacket (Printful #390)",
    runId: "demo-bomber-1",
    productId: 390,
    variantId: 10879,
    styleIds: [3015, 3016],
    technique: "cut-sew",
    productOptions: { stitch_color: "black" },
    design: {
      artwork_brief:
        "Midnight Japanese great wave seascape with rolling indigo swells, silver moonlit foam and " +
        "flying cranes with gold-accented wings, painterly woodblock style",
      style_terms: ["ukiyo-e woodblock", "sukajan souvenir jacket", "premium apparel art"],
      palette: ["midnight indigo", "silver white foam", "gold accents"]
    },
    jobs: [
      job("bomber-front", "front", 31, 36, "slice_from_master"),
      job("bomber-back", "back", 31, 36, "slice_from_master"),
      job("bomber-sl", "sleeve_left", 31, 36, "slice_from_master"),
      job("bomber-sr", "sleeve_right", 31, 36, "slice_from_master"),
      job("bomber-details", "details", 53, 18, "derive_from_master", "detail")
    ]
  },
  {
    name: "backpack",
    title: "AOP Backpack (Printful #279)",
    runId: "demo-backpack-1",
    productId: 279,
    variantId: 9063,
    styleIds: [16442, 16444],
    technique: "cut-sew",
    productOptions: { stitch_color: "black" },
    design: {
      artwork_brief:
        "Retro-futuristic topographic contour map in glowing teal and amber lines over charcoal, " +
        "with luminous route paths and waypoint glyphs",
      style_terms: ["topographic", "outdoor tech", "cartographic"],
      palette: ["charcoal", "glowing teal", "amber"]
    },
    jobs: [
      job("bp-front", "front", 14.5, 20.5, "slice_from_master"),
      job("bp-pocket", "pocket", 13, 8, "slice_from_master"),
      job("bp-top", "top", 28, 8, "derive_from_master", "detail"),
      job("bp-bottom", "bottom", 28, 5, "derive_from_master", "detail")
    ]
  }
];

const thumb = async (buffer: Buffer, maxW: number) =>
  sharp(buffer).resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
const b64 = (buffer: Buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`;

const renderMockups = async (
  demo: DemoCase,
  files: Record<string, string>,
  strategy: string,
  blocks: string[]
) => {
  const result = await createAndWaitForMockups({
    productId: demo.productId,
    variantIds: [demo.variantId],
    placements: Object.entries(files).map(([placement, fileUrl]) => ({
      placement,
      technique: demo.technique,
      fileUrl
    })),
    styleIds: demo.styleIds,
    productOptions: demo.productOptions,
    widthPx: 1000,
    maxAttempts: 90
  });
  await writeFile(path.join(OUT_DIR, `${demo.name}-task.json`), JSON.stringify(result.raw));
  const mockups = result.mockups;
  console.log(`Printful status=${result.status} mockups=${mockups.length}`);
  if (result.status === "failed") console.log(JSON.stringify(result.raw?.failure_reasons));

  const cells: string[] = [];
  for (let i = 0; i < mockups.length; i++) {
    try {
      const buffer = Buffer.from(await (await fetch(mockups[i].mockup_url)).arrayBuffer());
      await writeFile(
        path.join(OUT_DIR, `${demo.name}-official-${mockups[i].view.toLowerCase().replace(/\W+/g, "_")}-${i + 1}.jpg`),
        buffer
      );
      cells.push(
        `<figure><img src="${b64(await thumb(buffer, 640))}"/><figcaption><b>${mockups[i].view}</b> · style ${mockups[i].style_id} · rendered by Printful</figcaption></figure>`
      );
    } catch (error) {
      console.log(`  download failed: ${(error as Error).message}`);
    }
  }
  blocks.push(`
    <section>
      <h2>${demo.title}</h2>
      <p class="brief">${demo.design.artwork_brief}</p>
      <p class="meta">strategy ${strategy} · ${Object.keys(files).length} placement files</p>
      <div class="grid">${cells.join("")}</div>
    </section>`);
};

const run = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const compiler = new PanelCompiler(new RunwareMedia());
  const blocks: string[] = [];

  const only = (process.env.DEMO_ONLY ?? "").split(",").filter(Boolean);
  for (const demo of CASES) {
    if (only.length && !only.includes(demo.name)) continue;
    console.log(`\n=== ${demo.title} ===`);
    const profile = getCalibrationProfile(demo.productId);
    console.log(`calibration: ${profile ? Object.keys(profile).join(", ") : "none (piece=canvas)"}`);
    const filesPath = path.join(OUT_DIR, `${demo.name}-files.json`);
    if (process.env.REUSE_FILES === "1") {
      try {
        const reused = JSON.parse(await readFile(filesPath, "utf8")) as Record<string, string>;
        if (Object.keys(reused).length) {
          console.log("reusing previously compiled placement files");
          await renderMockups(demo, reused, "reused", blocks);
          continue;
        }
      } catch { /* no cached files; compile fresh */ }
    }
    const started = Date.now();
    const compiled = await compiler.compile(demo.runId, demo.jobs, demo.design, profile);
    console.log(
      `compile: strategy=${compiled.strategy} ok=${compiled.all_required_succeeded} ` +
        `missing=${compiled.missing_required_placements.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`
    );
    if (!compiled.all_required_succeeded) {
      console.log(JSON.stringify(compiled.missing_required_placements));
      continue;
    }
    const files: Record<string, string> = {};
    for (const panel of compiled.panels) {
      if (panel.status === "success" && panel.file_url) files[panel.placement] = panel.file_url;
    }
    await writeFile(path.join(OUT_DIR, `${demo.name}-files.json`), JSON.stringify(files, null, 1));

    await renderMockups(demo, files, compiled.strategy, blocks);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Threadbot — new AOP products (official Printful mockups)</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background:#121216; color:#eaeaf0; margin:0; padding:32px; }
    h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 40px; border-top: 1px solid #2c2c34; padding-top: 24px; }
    .brief { color:#c9c9d8; max-width: 70ch; } .meta { color:#8f8fa6; font-size: 13px; }
    img { border-radius: 8px; display:block; max-width: 100%; }
    .grid { display:flex; flex-wrap: wrap; gap: 16px; }
    figure { margin:0; max-width: 640px; } figcaption { font-size: 12px; color:#9a9ab0; margin-top: 6px; }
  </style></head><body>
  <h1>Threadbot — AOP shoes, bomber jacket, backpack</h1>
  <p class="meta">Panels compiled with analytic Printful-template calibration on Runware; every mockup below rendered by Printful's Mockup Generator API.</p>
  ${blocks.join("\n")}
  </body></html>`;
  await writeFile(path.join(OUT_DIR, "gallery.html"), html);
  console.log(`\nWrote ${OUT_DIR}/gallery.html`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
