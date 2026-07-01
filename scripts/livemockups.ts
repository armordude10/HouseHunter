/**
 * End-to-end AOP test with OFFICIAL PRINTFUL MOCKUPS as the final output.
 *
 * Hard rule (pipeline-wide): final visual outputs are Printful Mockup
 * Generator renders created through the Printful API (via the
 * threadbot_printful_mockups_mcp service) — never AI-generated mockups.
 *
 * Flow per garment:
 *   1. list_printful_mockup_styles      -> real placements, print areas, DPI,
 *                                          mockup style ids (Printful truth)
 *   2. Panel Compiler (Runware)         -> print files at exact Printful specs
 *   3. create_and_wait_for_printful_mockups -> official Printful mockup task
 *   4. download mockup URLs             -> gallery for review
 *
 * Products under test (discovered from the live Printful catalog):
 *   388  All-Over Print Recycled Unisex Hoodie  (front/back/sleeves/hood/pocket, 40x40" @150)
 *   257  All-Over Print Men's Crew Neck T-Shirt (default/back 28x36", sleeves 20x12")
 *   242  All-Over Print Yoga Leggings           (default 47x41", belt_front 20x7", belt_back 16x6")
 *
 * Usage: RUNWARE_API_KEY=... npx tsx scripts/livemockups.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RunwareMedia } from "../src/runware/media.js";
import { PanelCompiler, CompileJob, DesignSpec } from "../src/engine/panelCompiler.js";

const OUT_DIR = path.resolve("out/printful-mockups");
const MOCKUPS_MCP = "https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp";

const mcpText = (r: unknown): string => {
  const content = (r as { content?: Array<{ text?: string }> }).content;
  return Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : String(content);
};

interface GarmentCase {
  name: string;
  title: string;
  runId: string;
  productId: number;
  /** Placement keys to print (exact Printful keys) with design action. */
  placements: Array<{ key: string; action: string; workerType?: string }>;
  /** Substring to pick a variant by name; falls back to first variant. */
  variantPick: string;
  mockupStyleCount: number;
  design: DesignSpec;
}

const CASES: GarmentCase[] = [
  {
    name: "hoodie",
    title: "AOP Recycled Unisex Hoodie (Printful #388)",
    runId: "pf-aop-hoodie-1",
    productId: 388,
    variantPick: "White / M",
    mockupStyleCount: 2,
    placements: [
      { key: "front", action: "slice_from_master" },
      { key: "back", action: "slice_from_master" },
      { key: "sleeve_left", action: "slice_from_master" },
      { key: "sleeve_right", action: "slice_from_master" },
      { key: "hood", action: "slice_from_master" },
      { key: "pocket", action: "slice_from_master" }
    ],
    design: {
      artwork_brief:
        "Bioluminescent koi fish swimming through deep indigo night water among glowing " +
        "lotus flowers and drifting light particles, painterly ukiyo-e influence",
      style_terms: ["ukiyo-e", "bioluminescent", "painterly"],
      palette: ["deep indigo", "teal glow", "warm coral accents"]
    }
  },
  {
    name: "tee",
    title: "AOP Men's Crew Neck T-Shirt (Printful #257)",
    runId: "pf-aop-tee-1",
    productId: 257,
    variantPick: "White / M",
    mockupStyleCount: 2,
    placements: [
      { key: "default", action: "slice_from_master" },
      { key: "back", action: "slice_from_master" },
      { key: "sleeve_left", action: "slice_from_master" },
      { key: "sleeve_right", action: "slice_from_master" }
    ],
    design: {
      artwork_brief:
        "Retro synthwave sunset over a chrome ocean horizon with palm silhouettes and a " +
        "wireframe grid foreground, continuous sky gradient",
      style_terms: ["synthwave", "retrowave", "1980s poster art"],
      palette: ["hot magenta", "sunset orange", "electric purple", "cyan"]
    }
  },
  {
    name: "leggings",
    title: "AOP Yoga Leggings (Printful #242)",
    runId: "pf-aop-leggings-1",
    productId: 242,
    variantPick: "M",
    mockupStyleCount: 2,
    placements: [
      { key: "default", action: "repeat_pattern", workerType: "pattern" },
      { key: "belt_front", action: "repeat_pattern", workerType: "pattern" },
      { key: "belt_back", action: "repeat_pattern", workerType: "pattern" }
    ],
    design: {
      artwork_brief:
        "Art deco peacock feather geometric pattern, interlocking fans and eye motifs " +
        "with fine gold linework on deep emerald",
      style_terms: ["art deco", "geometric", "luxury textile"],
      palette: ["deep emerald", "metallic gold", "midnight teal"]
    }
  }
];

interface PlacementSpec {
  placement: string;
  widthIn: number;
  heightIn: number;
  dpi: number;
  styleIds: number[];
}

const fetchPlacementSpecs = async (mcp: Client, productId: number): Promise<PlacementSpec[]> => {
  const response = await mcp.callTool({
    name: "list_printful_mockup_styles",
    arguments: { product_id: productId, limit: 60 }
  });
  const body = JSON.parse(mcpText(response)) as {
    data: Array<{
      placement: string;
      print_area_width: number;
      print_area_height: number;
      dpi: number;
      mockup_styles: Array<{ id: number }>;
    }>;
  };
  return body.data.map((d) => ({
    placement: d.placement,
    widthIn: d.print_area_width,
    heightIn: d.print_area_height,
    dpi: d.dpi,
    styleIds: (d.mockup_styles ?? []).map((s) => s.id)
  }));
};

const pickVariant = async (productId: number, pick: string): Promise<number> => {
  const response = await fetch(`https://api.printful.com/products/${productId}`);
  const body = (await response.json()) as {
    result: { variants: Array<{ id: number; name: string }> };
  };
  const variants = body.result.variants;
  const match = variants.find((v) => v.name.includes(pick));
  return (match ?? variants[0]).id;
};

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

const thumb = async (buffer: Buffer, maxW: number) =>
  sharp(buffer).resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer();
const b64 = (buffer: Buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`;

const run = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const compiler = new PanelCompiler(new RunwareMedia());
  const mcp = new Client({ name: "threadbot-livemockups", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MOCKUPS_MCP)));

  const galleryBlocks: string[] = [];

  for (const garment of CASES) {
    console.log(`\n=== ${garment.title} ===`);
    const specs = await fetchPlacementSpecs(mcp, garment.productId);
    const specByKey = new Map(specs.map((s) => [s.placement, s]));
    const variantId = await pickVariant(garment.productId, garment.variantPick);
    console.log(`variant ${variantId}; placements from Printful: ${specs.map((s) => s.placement).join(", ")}`);

    // 1. Compile print files at exact Printful print-area specs.
    const jobs: CompileJob[] = garment.placements.map(({ key, action, workerType }) => {
      const spec = specByKey.get(key);
      if (!spec) throw new Error(`Printful does not list placement ${key} for product ${garment.productId}`);
      return {
        job_id: `${garment.name}-${key}`,
        placement: key,
        worker_type: workerType ?? "wrap",
        design_action: action,
        must_generate: true,
        must_render_in_mockup: true,
        geometry_contract: {
          width_px: Math.round(spec.widthIn * spec.dpi),
          height_px: Math.round(spec.heightIn * spec.dpi),
          dpi: spec.dpi
        },
        output_contract: { transparent_background: false }
      };
    });
    const started = Date.now();
    const compiled = await compiler.compile(garment.runId, jobs, garment.design);
    console.log(
      `compile: strategy=${compiled.strategy} ok=${compiled.all_required_succeeded} ` +
        `missing=${compiled.missing_required_placements.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`
    );
    if (!compiled.all_required_succeeded) {
      console.log(JSON.stringify(compiled.missing_required_placements, null, 2));
      continue;
    }

    const placementFileUrls: Record<string, string> = {};
    for (const panel of compiled.panels) {
      if (panel.status === "success" && panel.file_url) {
        placementFileUrls[panel.placement] = panel.file_url;
        console.log(`  ${panel.placement}: ${panel.file_url}`);
      }
    }

    // 2. Official Printful mockup task via the Printful API (hard rule).
    const styleIds = specByKey.get(garment.placements[0].key)!.styleIds.slice(0, garment.mockupStyleCount);
    console.log(`requesting Printful mockups, styles ${styleIds.join(", ")} ...`);
    const mockupStarted = Date.now();
    const taskResponse = await mcp.callTool(
      {
        name: "create_and_wait_for_printful_mockups",
        arguments: {
          product_id: garment.productId,
          variant_ids: [variantId],
          placement_file_urls: placementFileUrls,
          mockup_style_ids: styleIds,
          format: "jpg",
          mockup_width_px: 1200,
          max_attempts: 30,
          interval_seconds: 5
        }
      },
      undefined,
      { timeout: 300000 } // Printful mockup tasks can take minutes
    );
    const rawTask = mcpText(taskResponse);
    let mockupUrls: string[] = [];
    try {
      const extract = await mcp.callTool({
        name: "extract_printful_mockup_urls",
        arguments: { task_response: JSON.parse(rawTask) }
      });
      const parsed = JSON.parse(mcpText(extract));
      mockupUrls = (parsed.mockup_urls ?? parsed.urls ?? parsed) as string[];
    } catch {
      mockupUrls = [...rawTask.matchAll(/https?:\/\/[^"\s\\]+/g)]
        .map((m) => m[0])
        .filter((u) => /mockup|printful|files/.test(u));
    }
    if (!Array.isArray(mockupUrls)) mockupUrls = [];
    console.log(
      `Printful returned ${mockupUrls.length} mockup(s) in ${((Date.now() - mockupStarted) / 1000).toFixed(0)}s`
    );

    // 3. Download official mockups + build gallery block.
    const cells: string[] = [];
    for (let i = 0; i < mockupUrls.length; i++) {
      try {
        const buffer = await download(mockupUrls[i]);
        await writeFile(path.join(OUT_DIR, `${garment.name}-mockup-${i + 1}.jpg`), buffer);
        cells.push(
          `<figure><img src="${b64(await thumb(buffer, 560))}"/><figcaption>Printful mockup ${i + 1}</figcaption></figure>`
        );
      } catch (error) {
        console.log(`  mockup download failed: ${(error as Error).message}`);
      }
    }
    if (!cells.length) {
      console.log(`RAW TASK RESPONSE (truncated): ${rawTask.slice(0, 1200)}`);
    }

    const fileCells = await Promise.all(
      compiled.panels
        .filter((panel) => panel.file_url)
        .map(async (panel) => {
          const buffer = await download(panel.file_url!);
          const meta = await sharp(buffer).metadata();
          return `<figure><img src="${b64(await thumb(buffer, 220))}"/><figcaption>${panel.placement} · ${meta.width}×${meta.height}px</figcaption></figure>`;
        })
    );

    galleryBlocks.push(`
      <section>
        <h2>${garment.title}</h2>
        <p class="brief">${garment.design.artwork_brief}</p>
        <p class="meta">variant ${variantId} · strategy ${compiled.strategy} · ${
          Object.keys(placementFileUrls).length
        } placement files submitted · ${cells.length} official Printful mockups</p>
        <h3>Official Printful mockups (Mockup Generator API)</h3>
        <div class="grid">${cells.join("") || "<p>NO MOCKUPS RETURNED — see logs</p>"}</div>
        <h3>Print files submitted to Printful (Runware-generated panels)</h3>
        <div class="grid">${fileCells.join("")}</div>
      </section>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Threadbot — Official Printful mockups (AOP live test)</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background:#121216; color:#eaeaf0; margin:0; padding:32px; }
    h1 { font-size: 22px; } h2 { font-size: 18px; margin-top: 40px; border-top: 1px solid #2c2c34; padding-top: 24px; }
    h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color:#9a9ab0; margin: 18px 0 8px; }
    .brief { color:#c9c9d8; max-width: 70ch; } .meta { color:#8f8fa6; font-size: 13px; }
    img { border-radius: 8px; display:block; max-width: 100%; }
    .grid { display:flex; flex-wrap: wrap; gap: 14px; }
    figure { margin:0; } figcaption { font-size: 12px; color:#9a9ab0; margin-top: 6px; }
  </style></head><body>
  <h1>Threadbot — Official Printful mockups</h1>
  <p class="meta">Print files compiled by the garment-space engine on Runware, submitted to Printful's Mockup Generator API. Every mockup image below was rendered by Printful.</p>
  ${galleryBlocks.join("\n")}
  </body></html>`;
  await writeFile(path.join(OUT_DIR, "gallery.html"), html);
  console.log(`\nWrote ${OUT_DIR}/gallery.html`);
  await mcp.close();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
