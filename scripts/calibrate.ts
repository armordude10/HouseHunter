/**
 * Printful panel-mapping calibration.
 *
 * Submits deterministic calibration grids (not AI art) as print files to
 * Printful's Mockup Generator and renders official mockups. Reading the
 * mockups reveals, per placement, exactly WHICH region of the submitted file
 * canvas appears on the sewn piece, how pieces are oriented, and where the
 * seams fall — ground truth for the garment-space engine's canvas->piece
 * mapping, seam allowances, and print-safe areas.
 *
 * Each placement's grid encodes:
 *  - placement name repeated across the canvas (identifies the file)
 *  - 10%-cell grid with percent labels on both axes (localizes the region)
 *  - distinct border color per placement + corner markers:
 *      TL=red TR=green BL=blue BR=yellow (detects orientation/flips)
 *
 * Usage: RUNWARE_API_KEY=... npx tsx scripts/calibrate.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RunwareMedia } from "../src/runware/media.js";

const OUT_DIR = path.resolve("out/calibration");
const MOCKUPS_MCP = "https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp";

const mcpText = (r: unknown): string => {
  const content = (r as { content?: Array<{ text?: string }> }).content;
  return Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : String(content);
};

const PLACEMENT_COLORS: Record<string, string> = {
  front: "#d81b60",
  back: "#1e88e5",
  sleeve_left: "#43a047",
  sleeve_right: "#fb8c00",
  hood: "#8e24aa",
  pocket: "#00acc1",
  default: "#d81b60",
  belt_front: "#43a047",
  belt_back: "#fb8c00"
};

/** SVG calibration grid, rendered to PNG at gridPx square/rect. */
const calibrationPng = async (placement: string, width: number, height: number): Promise<Buffer> => {
  const color = PLACEMENT_COLORS[placement] ?? "#555";
  const cells = 10;
  const parts: string[] = [];
  parts.push(`<rect width="${width}" height="${height}" fill="#f5f2ea"/>`);
  for (let i = 0; i <= cells; i++) {
    const x = (i / cells) * width;
    const y = (i / cells) * height;
    const stroke = i % 5 === 0 ? "#222" : "#b9b2a2";
    const wLine = i % 5 === 0 ? 6 : 2;
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${stroke}" stroke-width="${wLine}"/>`);
    parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${stroke}" stroke-width="${wLine}"/>`);
  }
  const fs = Math.round(Math.min(width, height) / 28);
  for (let i = 1; i < cells; i++) {
    const x = (i / cells) * width;
    const y = (i / cells) * height;
    for (let j = 1; j < cells; j += 2) {
      parts.push(
        `<text x="${x + 6}" y="${(j / cells) * height - 8}" font-family="sans-serif" font-size="${fs}" fill="#6b6355">${i * 10},${j * 10}</text>`
      );
    }
    parts.push(`<text x="${x - fs}" y="${fs * 1.2}" font-family="sans-serif" font-size="${fs}" font-weight="bold" fill="#333">${i * 10}</text>`);
    parts.push(`<text x="8" y="${y + fs / 2}" font-family="sans-serif" font-size="${fs}" font-weight="bold" fill="#333">${i * 10}</text>`);
  }
  const nameFs = Math.round(Math.min(width, height) / 10);
  for (const [fy, weight] of [[0.28, "bold"], [0.52, "bold"], [0.76, "bold"]] as const) {
    parts.push(
      `<text x="${width / 2}" y="${height * fy}" font-family="sans-serif" font-size="${nameFs}" font-weight="${weight}" fill="${color}" text-anchor="middle" opacity="0.85">${placement.toUpperCase()}</text>`
    );
  }
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="${color}" stroke-width="${Math.round(width / 60)}"/>`);
  const m = Math.round(Math.min(width, height) / 8);
  parts.push(`<rect x="0" y="0" width="${m}" height="${m}" fill="#e53935"/>`);
  parts.push(`<rect x="${width - m}" y="0" width="${m}" height="${m}" fill="#43a047"/>`);
  parts.push(`<rect x="0" y="${height - m}" width="${m}" height="${m}" fill="#1e88e5"/>`);
  parts.push(`<rect x="${width - m}" y="${height - m}" width="${m}" height="${m}" fill="#fdd835"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
};

interface CalCase {
  name: string;
  productId: number;
  variantId: number;
  placements: Array<{ key: string; widthIn: number; heightIn: number }>;
  styleIds: number[];
}

const CASES: CalCase[] = [
  {
    name: "hoodie388",
    productId: 388,
    variantId: 18730,
    styleIds: [20132, 20133, 20134, 20135],
    placements: [
      { key: "front", widthIn: 40, heightIn: 40 },
      { key: "back", widthIn: 40, heightIn: 40 },
      { key: "sleeve_left", widthIn: 40, heightIn: 40 },
      { key: "sleeve_right", widthIn: 40, heightIn: 40 },
      { key: "hood", widthIn: 40, heightIn: 40 },
      { key: "pocket", widthIn: 40, heightIn: 40 }
    ]
  },
  {
    name: "tee257",
    productId: 257,
    variantId: 8852,
    styleIds: [15710, 15711, 15712, 15713],
    placements: [
      { key: "default", widthIn: 28, heightIn: 36 },
      { key: "back", widthIn: 28, heightIn: 36 },
      { key: "sleeve_left", widthIn: 20, heightIn: 12 },
      { key: "sleeve_right", widthIn: 20, heightIn: 12 }
    ]
  },
  {
    name: "leggings242",
    productId: 242,
    variantId: 8355,
    styleIds: [15516, 15517, 15518, 15519],
    placements: [
      { key: "default", widthIn: 47, heightIn: 41 },
      { key: "belt_front", widthIn: 20, heightIn: 7 },
      { key: "belt_back", widthIn: 16, heightIn: 6 }
    ]
  }
];

/** Fresh MCP connection per call — long retry waits kill idle transports. */
const callMockupsMcp = async (
  name: string,
  args: Record<string, unknown>
): Promise<string> => {
  const mcp = new Client({ name: "threadbot-calibrate", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MOCKUPS_MCP)));
  try {
    const response = await mcp.callTool({ name, arguments: args }, undefined, {
      timeout: 300000
    });
    return mcpText(response);
  } finally {
    await mcp.close().catch(() => {});
  }
};

const run = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const media = new RunwareMedia();

  for (const cal of CASES) {
    console.log(`\n=== calibrating ${cal.name}`);
    const files: Record<string, string> = {};
    for (const p of cal.placements) {
      // Working grid at 1/4 print scale, hosted via upload -> 4x upscale is
      // wasteful for flat graphics; Printful only needs sufficient px. Render
      // at ~37.5 px/in (1500px for 40"), upload, upscale x2 for crispness.
      const wPx = Math.round(p.widthIn * 37.5);
      const hPx = Math.round(p.heightIn * 37.5);
      const png = await calibrationPng(p.key, wPx, hPx);
      await writeFile(path.join(OUT_DIR, `${cal.name}-${p.key}-grid.png`), png);
      const uuid = await media.uploadImage(`data:image/png;base64,${png.toString("base64")}`);
      // JPG output: flat grids upscale to huge noisy PNGs that stall
      // Printful's file pre-processing; JPG stays small and processes fast.
      const hosted = await media.upscale(uuid, 2, "JPG");
      files[p.key] = hosted.imageURL;
      console.log(`  ${p.key}: ${hosted.imageURL}`);
    }
    // Printful rejects heavy tasks ("would exceed available attempts"), so
    // request at most 2 mockup styles per task and merge results.
    const mockups: Array<{ view: string; mockup_url: string; style_id: number }> = [];
    for (let chunkStart = 0; chunkStart < cal.styleIds.length; chunkStart += 2) {
      const styleChunk = cal.styleIds.slice(chunkStart, chunkStart + 2);
      let raw = "";
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          raw = await callMockupsMcp("create_and_wait_for_printful_mockups", {
            product_id: cal.productId,
            variant_ids: [cal.variantId],
            placement_file_urls: files,
            mockup_style_ids: styleChunk,
            format: "jpg",
            mockup_width_px: 1600,
            max_attempts: 30,
            interval_seconds: 5
          });
          break;
        } catch (error) {
          const message = (error as Error).message;
          const transient =
            /429|TooManyRequests|exceed available attempts|PREUPLOAD_NOT_READY|file_status.*waiting|internal-server-error|fetch failed|other side closed|socket|timed? ?out/i.test(
              message
            );
          if (attempt < 6 && transient) {
            const wait = 45000;
            console.log(`  transient Printful condition; waiting ${wait / 1000}s (attempt ${attempt}): ${message.slice(0, 120)}`);
            await new Promise((resolve) => setTimeout(resolve, wait));
            continue;
          }
          throw error;
        }
      }
      await writeFile(path.join(OUT_DIR, `${cal.name}-task-${chunkStart / 2}.json`), raw);
      const task = JSON.parse(raw)?.waited?.task?.data?.[0];
      mockups.push(
        ...(task?.catalog_variant_mockups ?? []).flatMap((g: { mockups: never[] }) => g.mockups)
      );
      console.log(`  styles ${styleChunk.join(",")}: status=${task?.status}`);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
    console.log(`  total mockups=${mockups.length}`);
    for (const m of mockups) {
      try {
        const buffer = Buffer.from(await (await fetch(m.mockup_url)).arrayBuffer());
        await writeFile(
          path.join(OUT_DIR, `${cal.name}-view-${m.view.toLowerCase().replace(/\W+/g, "_")}-${m.style_id}.jpg`),
          buffer
        );
      } catch (error) {
        console.log(`  view ${m.view} download failed: ${(error as Error).message}`);
      }
    }
  }
  console.log(`\nCalibration renders in ${OUT_DIR}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
