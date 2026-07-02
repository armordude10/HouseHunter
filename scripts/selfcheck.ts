/**
 * Offline engine self-check (no RUNWARE_API_KEY needed).
 *
 * Proves, with pixels rather than promises, the two guarantees the engine
 * exists to provide:
 *
 *   1. SEAM CONTINUITY — for a 4-panel AOP crew neck the art at back's right
 *      edge must equal the art at front's left edge (shared cut line on the
 *      garment plane). Verified numerically on the actual output PNGs for
 *      both master_slice and pattern_tile strategies.
 *
 *   2. FULL COVERAGE — every placement job in the plan yields exactly one
 *      bundle entry (success/blank/failed), a single-front Gildan 5000 plan
 *      collapses to one direct generation, blanks are accounted, and a
 *      failed panel surfaces in missing_required_placements instead of
 *      disappearing.
 *
 * Media is stubbed with deterministic local rasters (gradients) so the check
 * exercises the real layout/slice/tile math end to end.
 */

import sharp from "sharp";
import {
  classifyStrategy,
  CompileJob,
  DesignSpec,
  MediaLike,
  PanelCompiler
} from "../src/engine/panelCompiler.js";
import { buildGarmentPlane } from "../src/engine/garmentSpace.js";

// -----------------------------------------------------------------------------
// Stub media: horizontal-gradient "generations", local resize "upscales".
// -----------------------------------------------------------------------------

const gradientPng = async (
  width: number,
  height: number,
  wave: "linear" | "triangle" = "linear"
): Promise<Buffer> => {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const t = x / Math.max(1, width - 1);
      // triangle: left and right edges match (a genuinely seamless swatch)
      raw[i] = Math.round(255 * (wave === "triangle" ? 1 - Math.abs(2 * t - 1) : t));
      raw[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      raw[i + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
};

const toDataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString("base64")}`;

class StubMedia implements MediaLike {
  uploads = new Map<string, Buffer>();
  generateCalls = 0;
  failFor: string | null = null;
  wave: "linear" | "triangle" = "linear";

  async generateImage(params: { positivePrompt: string; width: number; height: number }) {
    this.generateCalls++;
    if (this.failFor && params.positivePrompt.includes(this.failFor)) {
      throw new Error(`stubbed generation failure for ${this.failFor}`);
    }
    return { imageURL: toDataUrl(await gradientPng(params.width, params.height, this.wave)) };
  }

  async removeBackground(imageUrl: string) {
    return { imageURL: imageUrl };
  }

  async upscale(image: string, factor: 2 | 3 | 4) {
    const buffer = this.uploads.get(image) ?? Buffer.from(image.split(",")[1] ?? "", "base64");
    const meta = await sharp(buffer).metadata();
    const out = await sharp(buffer)
      .resize((meta.width ?? 1) * factor, (meta.height ?? 1) * factor, { fit: "fill" })
      .png()
      .toBuffer();
    return { imageURL: toDataUrl(out) };
  }

  async uploadImage(image: string) {
    const uuid = `upload-${this.uploads.size}`;
    this.uploads.set(uuid, Buffer.from(image.split(",")[1] ?? "", "base64"));
    return uuid;
  }
}

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

const columnMean = async (dataUrl: string, side: "left" | "right") => {
  const buffer = Buffer.from(dataUrl.split(",")[1], "base64");
  const meta = await sharp(buffer).metadata();
  // NOTE: sharp's .stats() reads the INPUT image and ignores pipeline ops,
  // so the column must be materialized to a buffer before measuring.
  const column = await sharp(buffer)
    .extract({
      left: side === "left" ? 0 : (meta.width ?? 1) - 1,
      top: 0,
      width: 1,
      height: meta.height ?? 1
    })
    .png()
    .toBuffer();
  const stats = await sharp(column).stats();
  return stats.channels[0].mean; // red channel = horizontal position signal
};

let failures = 0;
const check = (name: string, condition: boolean, detail = "") => {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
};

const aopJob = (
  id: string,
  placement: string,
  widthPx: number,
  heightPx: number,
  extra: Partial<CompileJob> = {}
): CompileJob => ({
  job_id: id,
  placement,
  worker_type: "wrap",
  design_action: "slice_from_master",
  must_generate: true,
  must_render_in_mockup: true,
  geometry_contract: { width_px: widthPx, height_px: heightPx, dpi: 100 },
  output_contract: { transparent_background: false },
  ...extra
});

const design: DesignSpec = { artwork_brief: "flowing abstract ocean waves", palette: ["deep blue"] };

// -----------------------------------------------------------------------------
// Scenarios.
// -----------------------------------------------------------------------------

const run = async () => {
  console.log("\n== Scenario 1: AOP crew neck (front/back/left_sleeve/right_sleeve) ==");
  {
    const jobs = [
      aopJob("j-front", "front", 1200, 1440),
      aopJob("j-back", "back", 1200, 1440),
      aopJob("j-ls", "left_sleeve", 600, 600),
      aopJob("j-rs", "right_sleeve", 600, 600)
    ];
    check("strategy is master_slice", classifyStrategy(jobs) === "master_slice");

    const plane = buildGarmentPlane(
      jobs.map((j) => ({
        placement: j.placement,
        width_px: j.geometry_contract?.width_px,
        height_px: j.geometry_contract?.height_px,
        dpi: j.geometry_contract?.dpi
      }))
    );
    const backFront = plane.seams.find((s) => s.a === "back" && s.b === "front");
    check("back|front share a vertical cut line", Boolean(backFront));
    check(
      "seam count for 4-panel row is 3",
      plane.seams.filter((s) => s.edge === "vertical").length === 3
    );

    const media = new StubMedia();
    const result = await new PanelCompiler(media).compile("selfcheck-aop", jobs, design);
    check("one master generation only", media.generateCalls === 1);
    check("4 jobs -> 4 bundle entries", result.panels.length === 4);
    check(
      "all required panels succeeded with file URLs",
      result.all_required_succeeded &&
        result.panels.every((p) => p.status === "success" && p.file_url)
    );
    check("no missing required placements", result.missing_required_placements.length === 0);

    const back = result.panels.find((p) => p.placement === "back")!;
    const front = result.panels.find((p) => p.placement === "front")!;
    const backEdge = await columnMean(back.file_url!, "right");
    const frontEdge = await columnMean(front.file_url!, "left");
    check(
      "SEAM CONTINUITY: back.right edge == front.left edge",
      Math.abs(backEdge - frontEdge) < 6,
      `edge means ${backEdge.toFixed(1)} vs ${frontEdge.toFixed(1)}`
    );

    const finalMeta = await sharp(
      Buffer.from(back.file_url!.split(",")[1], "base64")
    ).metadata();
    check(
      "back panel meets print spec (>= 1200x1440)",
      (finalMeta.width ?? 0) >= 1200 && (finalMeta.height ?? 0) >= 1440,
      `${finalMeta.width}x${finalMeta.height}`
    );
    check(
      "genome records crop math for every sliced panel",
      result.genome.panels.filter((p) => p.crop_px).length === 4
    );
  }

  console.log("\n== Scenario 2: Gildan 5000 (front placement only) ==");
  {
    const jobs: CompileJob[] = [
      {
        job_id: "j-front",
        placement: "front",
        worker_type: "hero",
        design_action: "generate_unique_art",
        must_generate: true,
        must_render_in_mockup: true,
        geometry_contract: { width_px: 1200, height_px: 1600, dpi: 100 },
        output_contract: { transparent_background: true }
      }
    ];
    check("strategy is direct", classifyStrategy(jobs) === "direct");
    const media = new StubMedia();
    const result = await new PanelCompiler(media).compile("selfcheck-gildan", jobs, design);
    check("single generation call", media.generateCalls === 1);
    check(
      "one success entry, transparent, mockup-renderable",
      result.panels.length === 1 &&
        result.panels[0].status === "success" &&
        result.panels[0].transparent_background === true
    );
    check("no missing required placements", result.missing_required_placements.length === 0);
  }

  console.log("\n== Scenario 3: repeat-pattern AOP (front/back) phase-locked tiling ==");
  {
    // 10" wide panels with a 6" tile: the back|front seam lands at garment
    // x=10", i.e. 2/3 of the way through a tile — a real phase test, not a
    // tile-boundary coincidence. With a seamless triangle-wave swatch the
    // expected red value at the seam is 255*(1-|2*(2/3)-1|) = 170.
    const jobs = [
      aopJob("j-back", "back", 1000, 1440, { design_action: "repeat_pattern" }),
      aopJob("j-front", "front", 1000, 1440, { design_action: "repeat_pattern" })
    ];
    check("strategy is pattern_tile", classifyStrategy(jobs) === "pattern_tile");
    const media = new StubMedia();
    media.wave = "triangle";
    const result = await new PanelCompiler(media).compile("selfcheck-pattern", jobs, design);
    check("one swatch generation only", media.generateCalls === 1);
    check(
      "both panels tiled successfully",
      result.panels.every((p) => p.status === "success" && p.generation_mode === "repeated")
    );
    const back = result.panels.find((p) => p.placement === "back")!;
    const front = result.panels.find((p) => p.placement === "front")!;
    const backEdge = await columnMean(back.file_url!, "right");
    const frontEdge = await columnMean(front.file_url!, "left");
    check(
      "PATTERN PHASE CONTINUITY: back.right edge == front.left edge (mid-tile seam)",
      Math.abs(backEdge - frontEdge) < 12,
      `edge means ${backEdge.toFixed(1)} vs ${frontEdge.toFixed(1)}`
    );
    check(
      "phase value matches garment-space arithmetic (~170)",
      Math.abs(backEdge - 170) < 14 && Math.abs(frontEdge - 170) < 14,
      `expected ~170, got ${backEdge.toFixed(1)} / ${frontEdge.toFixed(1)}`
    );
  }

  console.log("\n== Scenario 4: blanks + failures are accounted, never silent ==");
  {
    const jobs = [
      aopJob("j-front", "front", 1200, 1440),
      aopJob("j-back", "back", 1200, 1440),
      {
        job_id: "j-label",
        placement: "inside_label",
        design_action: "leave_blank",
        must_generate: false
      } as CompileJob
    ];
    const media = new StubMedia();
    const result = await new PanelCompiler(media).compile("selfcheck-blank", jobs, design);
    check("3 jobs -> 3 bundle entries (blank included)", result.panels.length === 3);
    check(
      "blank entry is explicit, not missing",
      result.panels.some((p) => p.status === "blank") &&
        result.missing_required_placements.length === 0
    );

    const failingMedia = new StubMedia();
    failingMedia.failFor = "continuous mural"; // kill the master generation
    const failed = await new PanelCompiler(failingMedia).compile("selfcheck-fail", jobs, design);
    check(
      "master failure reports BOTH panels as missing required",
      failed.missing_required_placements.length === 2 && !failed.all_required_succeeded,
      JSON.stringify(failed.missing_required_placements.map((m) => m.placement))
    );
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
