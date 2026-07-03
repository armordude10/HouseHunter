/**
 * Adversarial stress suite (offline — stubbed media, no API spend).
 *
 * Attacks every deterministic layer of the pipeline with hostile and
 * degenerate inputs and asserts the two invariants that must never break:
 *
 *   1. TOTAL ACCOUNTING — every placement job yields exactly one bundle
 *      entry (success/blank/failed with an honest reason). No silent drops,
 *      no crashes, no partial bundles that claim success.
 *   2. CORRECTNESS UNDER CALIBRATION — seam continuity holds at PIECE edges
 *      when pieces occupy sub-regions of their canvases, phase-locked
 *      patterns stay aligned, and degenerate geometry cannot produce
 *      unbounded memory, absurd files, or misattributed art.
 *
 * Run: npm run stress
 */

import sharp from "sharp";
import {
  classifyStrategy,
  CompileJob,
  DesignSpec,
  MediaLike,
  PanelCompiler,
  workingSize
} from "../src/engine/panelCompiler.js";
import { buildGarmentPlane } from "../src/engine/garmentSpace.js";
import { clampFluxDimension, RunwareMedia } from "../src/runware/media.js";
import { tileExact } from "../src/engine/raster.js";
import { capText } from "../src/runware/agent.js";
import { normalizeCustomerImages, MAX_CUSTOMER_IMAGES } from "../src/workflow.js";
import { registerRunContext, getRunContext } from "../src/engine/runContext.js";
import { createGeneratePanelArtworkBundleTool } from "../src/tools/artworkBundleTool.js";

// -----------------------------------------------------------------------------
// Harness.
// -----------------------------------------------------------------------------

let failures = 0;
let checks = 0;
const check = (name: string, condition: boolean, detail = "") => {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (name: string) => console.log(`\n== ${name} ==`);

const gradientPng = async (width: number, height: number): Promise<Buffer> => {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = Math.round((x / Math.max(1, w - 1)) * 255);
      raw[i + 1] = Math.round((y / Math.max(1, h - 1)) * 255);
      raw[i + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
};
const toDataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString("base64")}`;

class StubMedia implements MediaLike {
  uploads = new Map<string, Buffer>();
  generateCalls = 0;
  maxGeneratedDim = 0;
  failFor: string | null = null;

  async generateImage(params: { positivePrompt: string; width: number; height: number }) {
    this.generateCalls++;
    this.maxGeneratedDim = Math.max(this.maxGeneratedDim, params.width, params.height);
    if (params.width > 2048 || params.height > 2048 || params.width < 128 || params.height < 128) {
      throw new Error(`stub: invalid generation dims ${params.width}x${params.height}`);
    }
    if (this.failFor && params.positivePrompt.includes(this.failFor)) {
      throw new Error(`stubbed generation failure`);
    }
    return { imageURL: toDataUrl(await gradientPng(params.width, params.height)) };
  }
  async removeBackground(imageUrl: string) {
    return { imageURL: imageUrl };
  }
  async upscale(image: string, factor: 2 | 3 | 4) {
    const buffer = this.uploads.get(image) ?? Buffer.from(image.split(",")[1] ?? "", "base64");
    const meta = await sharp(buffer).metadata();
    const w = (meta.width ?? 1) * factor;
    const h = (meta.height ?? 1) * factor;
    if (w > 20000 || h > 20000) throw new Error(`stub: upscale output too large ${w}x${h}`);
    const out = await sharp(buffer).resize(w, h, { fit: "fill" }).png().toBuffer();
    return { imageURL: toDataUrl(out) };
  }
  async uploadImage(image: string) {
    const payload = Buffer.from(image.split(",")[1] ?? "", "base64");
    if (payload.length > 80 * 1024 * 1024) throw new Error("stub: upload too large");
    const uuid = `upload-${this.uploads.size}`;
    this.uploads.set(uuid, payload);
    return uuid;
  }
}

const design: DesignSpec = {
  artwork_brief: "flowing abstract tidal waves with luminous foam",
  palette: ["indigo", "teal"],
  forbidden_text: ["FORBIDDENWORD", "EvilBrand"]
};

const baseJob = (id: string, placement: string, extra: Partial<CompileJob> = {}): CompileJob => ({
  job_id: id,
  placement,
  worker_type: "wrap",
  design_action: "slice_from_master",
  must_generate: true,
  must_render_in_mockup: true,
  geometry_contract: { width_px: 1200, height_px: 1440, dpi: 100 },
  output_contract: { transparent_background: false },
  ...extra
});

const accounted = (jobs: CompileJob[], panels: Array<{ job_id: string }>) => {
  const ids = panels.map((panel) => panel.job_id).sort();
  const expected = jobs.map((job) => job.job_id).sort();
  return ids.length === expected.length && ids.every((id, i) => id === expected[i]);
};

const columnRed = async (dataUrl: string, xFrac: number) => {
  const buffer = Buffer.from(dataUrl.split(",")[1], "base64");
  const meta = await sharp(buffer).metadata();
  const x = Math.min((meta.width ?? 1) - 1, Math.max(0, Math.round((meta.width ?? 1) * xFrac)));
  const column = await sharp(buffer)
    .extract({ left: x, top: 0, width: 1, height: meta.height ?? 1 })
    .png()
    .toBuffer();
  return (await sharp(column).stats()).channels[0].mean;
};

// -----------------------------------------------------------------------------
// Attack groups.
// -----------------------------------------------------------------------------

const run = async () => {
  // --- A. Geometry pathology -------------------------------------------------
  section("A. Geometry pathology");
  {
    const evil: Array<[string, unknown, unknown, unknown]> = [
      ["zero dims", 0, 0, 150],
      ["negative dims", -500, -900, 150],
      ["NaN dims", Number.NaN, Number.NaN, Number.NaN],
      ["string dims", "abc" as unknown, "def" as unknown, "ghi" as unknown],
      ["gigantic dims", 1e9, 1e9, 150],
      ["1px", 1, 1, 1],
      ["missing geometry", undefined, undefined, undefined],
      ["extreme aspect", 15900, 750, 300]
    ];
    for (const [label, w, h, dpi] of evil) {
      const jobs = [
        baseJob("g-front", "front", {
          geometry_contract: { width_px: w as number, height_px: h as number, dpi: dpi as number }
        }),
        baseJob("g-back", "back", {
          geometry_contract: { width_px: w as number, height_px: h as number, dpi: dpi as number }
        })
      ];
      const media = new StubMedia();
      try {
        const result = await new PanelCompiler(media).compile(`stress-geo-${label}`, jobs, design);
        check(`geometry(${label}): total accounting`, accounted(jobs, result.panels));
        check(
          `geometry(${label}): no oversized generation`,
          media.maxGeneratedDim <= 2048,
          `max dim ${media.maxGeneratedDim}`
        );
      } catch (error) {
        check(`geometry(${label}): must not throw`, false, (error as Error).message.slice(0, 120));
      }
    }
  }

  // --- B. Structural pathology -------------------------------------------------
  section("B. Structural pathology");
  {
    const media = new StubMedia();
    const empty = await new PanelCompiler(media).compile("stress-empty", [], design);
    check("empty plan: zero panels, success", empty.panels.length === 0 && empty.all_required_succeeded);

    const dup = [
      baseJob("d-1", "front"),
      baseJob("d-2", "front"),
      baseJob("d-3", "back"),
      baseJob("d-3", "back") // duplicate job id too
    ];
    const dupResult = await new PanelCompiler(new StubMedia()).compile("stress-dup", dup, design);
    check("duplicate placements/job_ids: one entry per job", dupResult.panels.length === dup.length);

    const blanks = [
      baseJob("b-1", "front", { design_action: "leave_blank", must_generate: false }),
      baseJob("b-2", "back", { design_action: "leave_blank", must_generate: false })
    ];
    const blankMedia = new StubMedia();
    const blankResult = await new PanelCompiler(blankMedia).compile("stress-blank", blanks, design);
    check(
      "all-blank plan: no generation calls, all accounted blank",
      blankMedia.generateCalls === 0 &&
        blankResult.panels.every((panel) => panel.status === "blank") &&
        blankResult.missing_required_placements.length === 0
    );

    const big = Array.from({ length: 24 }, (_, i) =>
      baseJob(`m-${i}`, ["front", "back", "sleeve_left", "sleeve_right", "hood", "pocket", "extra_" + i][i % 7] ?? `p${i}`, {
        design_action: i % 2 ? "repeat_pattern" : "slice_from_master"
      })
    );
    const bigResult = await new PanelCompiler(new StubMedia()).compile("stress-big", big, design);
    check("24-job mixed plan: total accounting", accounted(big, bigResult.panels));
  }

  // --- C. Mirror pathology -----------------------------------------------------
  section("C. Mirror pathology");
  {
    const orphan = [baseJob("mo-1", "left_sleeve", { design_action: "mirror_from_pair", source_job_id: "ghost" })];
    const orphanResult = await new PanelCompiler(new StubMedia()).compile("stress-mirror-orphan", orphan, design);
    check(
      "mirror without source: honest failure",
      orphanResult.panels[0]?.status === "failed" &&
        orphanResult.missing_required_placements.length === 1
    );

    const failingMedia = new StubMedia();
    failingMedia.failFor = "sleeve_right";
    const pair = [
      baseJob("mp-src", "sleeve_right", { design_action: "generate_unique_art", prompt: "art for sleeve_right panel" }),
      baseJob("mp-mir", "sleeve_left", { design_action: "mirror_from_pair", source_job_id: "mp-src" })
    ];
    const pairResult = await new PanelCompiler(failingMedia).compile("stress-mirror-failsrc", pair, design);
    check(
      "mirror of failed source: both accounted, both missing",
      accounted(pair, pairResult.panels) && pairResult.missing_required_placements.length === 2
    );
  }

  // --- D. Calibration abuse ------------------------------------------------------
  section("D. Calibration abuse");
  {
    const jobs = [baseJob("c-front", "front"), baseJob("c-back", "back")];
    const evilProfiles = [
      { front: { pieceWFrac: 0, pieceHFrac: -1, pieceCxFrac: 99, pieceCyFrac: Number.NaN } },
      { front: { pieceWFrac: 2, pieceHFrac: 2, pieceCxFrac: -5, pieceCyFrac: 5 } },
      {
        front: { pieceWFrac: 0.5, pieceHFrac: 0.5, pieceCxFrac: 0.5, pieceCyFrac: 0.5 },
        pocket: {
          pieceWFrac: 0.3,
          pieceHFrac: 0.2,
          pieceCxFrac: 0.5,
          pieceCyFrac: 0.5,
          anchor: { relativeTo: "nonexistent", dxFrac: 9, dyFrac: -9 }
        }
      }
    ];
    for (let i = 0; i < evilProfiles.length; i++) {
      try {
        const result = await new PanelCompiler(new StubMedia()).compile(
          `stress-cal-${i}`,
          jobs,
          design,
          evilProfiles[i] as never
        );
        check(`calibration abuse #${i}: total accounting`, accounted(jobs, result.panels));
      } catch (error) {
        check(`calibration abuse #${i}: must not throw`, false, (error as Error).message.slice(0, 120));
      }
    }
  }

  // --- E. Continuity under calibrated windows ------------------------------------
  section("E. Continuity under calibrated windows");
  {
    const profile = {
      front: { pieceWFrac: 0.64, pieceHFrac: 0.78, pieceCxFrac: 0.5, pieceCyFrac: 0.54 },
      back: { pieceWFrac: 0.64, pieceHFrac: 0.78, pieceCxFrac: 0.5, pieceCyFrac: 0.54 }
    };
    const jobs = [baseJob("e-back", "back"), baseJob("e-front", "front")];
    const result = await new PanelCompiler(new StubMedia()).compile("stress-cal-seam", jobs, design, profile);
    const back = result.panels.find((panel) => panel.placement === "back")!;
    const front = result.panels.find((panel) => panel.placement === "front")!;
    check("calibrated slice: both succeed", back.status === "success" && front.status === "success");
    // Piece edges: back piece right edge sits at canvas frac cx + w/2; the
    // art there must equal front piece's left edge (cx - w/2).
    const backEdge = await columnRed(back.file_url!, 0.5 + 0.32);
    const frontEdge = await columnRed(front.file_url!, 0.5 - 0.32);
    check(
      "calibrated seam continuity at PIECE edges",
      Math.abs(backEdge - frontEdge) < 8,
      `${backEdge.toFixed(1)} vs ${frontEdge.toFixed(1)}`
    );

    const patternJobs = [
      baseJob("ep-back", "back", { design_action: "repeat_pattern" }),
      baseJob("ep-front", "front", { design_action: "repeat_pattern" })
    ];
    const patternResult = await new PanelCompiler(new StubMedia()).compile(
      "stress-cal-pattern",
      patternJobs,
      { ...design, pattern_tile_inches: 5 },
      profile
    );
    check(
      "calibrated pattern: both tiled",
      patternResult.panels.every((panel) => panel.status === "success")
    );
  }

  // --- F. Utility hardening ---------------------------------------------------
  section("F. Utility hardening");
  {
    let ok = true;
    for (let i = 0; i < 2000; i++) {
      const w = 1 + Math.floor(Math.random() * 20000);
      const h = 1 + Math.floor(Math.random() * 20000);
      const sizing = workingSize(w, h);
      if (![2, 4].includes(sizing.factor)) ok = false;
      if (sizing.width * sizing.factor < w - sizing.factor) ok = false;
      if (sizing.height * sizing.factor < h - sizing.factor) ok = false;
    }
    check("workingSize property test (2000 random dims)", ok);

    let clampOk = true;
    for (const value of [-100, 0, 1, 255, 257, 2047, 2049, 99999, Number.NaN]) {
      const clamped = clampFluxDimension(value);
      if (Number.isNaN(clamped) || clamped < 256 || clamped > 2048 || clamped % 16 !== 0) clampOk = false;
    }
    check("clampFluxDimension bounds + multiples of 16", clampOk, "");

    const tile = { buffer: await gradientPng(4, 4), width: 4, height: 4 };
    const tiled = await tileExact(tile, {
      outWidth: 64,
      outHeight: 64,
      tileWidth: 0.4,
      tileHeight: 0.4,
      offsetX: -1e7,
      offsetY: 1e7,
      dpi: 150
    });
    const tiledMeta = await sharp(tiled).metadata();
    check("tileExact degenerate tile + huge offsets", tiledMeta.width === 64 && tiledMeta.height === 64);

    const capped = capText("x".repeat(100000), 1000);
    check("capText truncates with head+tail", capped.length < 1200 && capped.includes("truncated"));

    const { accepted, rejected } = normalizeCustomerImages([
      "https://a.example/1.png",
      "https://a.example/1.png", // duplicate
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "ftp://files/x.png",
      "not a url",
      ...Array.from({ length: 12 }, (_, i) => `https://a.example/extra-${i}.png`)
    ]);
    check(
      `customer images: cap ${MAX_CUSTOMER_IMAGES}, dedupe, scheme filter`,
      accepted.length === MAX_CUSTOMER_IMAGES &&
        accepted.every((url) => url.startsWith("https://")) &&
        rejected.length >= 6
    );

    registerRunContext({ runId: "run-A", customerImageUrls: ["https://a/x.png"], customerImageCaptions: [] });
    registerRunContext({ runId: "run-B", customerImageUrls: ["https://b/y.png"], customerImageCaptions: [] });
    check(
      "run context isolation: unknown id with multiple runs -> null",
      getRunContext("run-A")?.customerImageUrls[0] === "https://a/x.png" && getRunContext("run-ZZZ") === null
    );
  }

  // --- G. Tool contract abuse ---------------------------------------------------
  section("G. Tool contract abuse");
  {
    const tool = createGeneratePanelArtworkBundleTool(new StubMedia() as unknown as RunwareMedia);
    const badJson = JSON.parse(await tool.execute({ run_id: "t1", surface_plan_json: "{not json" }));
    check("tool: invalid surface_plan_json -> structured error", typeof badJson.error === "string");

    const noJobs = JSON.parse(await tool.execute({ run_id: "t2", surface_plan_json: "{}" }));
    check("tool: empty plan -> structured error", typeof noJobs.error === "string");

    const tooMany = JSON.parse(
      await tool.execute({
        run_id: "t3",
        surface_plan_json: JSON.stringify({
          placement_jobs: Array.from({ length: 41 }, (_, i) => ({ job_id: `j${i}`, placement: `p${i}` }))
        })
      })
    );
    check("tool: 41-job plan -> safety limit error", /safety limit/.test(tooMany.error ?? ""));

    const good = JSON.parse(
      await tool.execute({
        run_id: "t4",
        surface_plan_json: JSON.stringify({
          product_id: "388",
          placement_jobs: [
            { job_id: "f", placement: "front", design_action: "generate_unique_art", geometry_contract: { width_px: 800, height_px: 800, dpi: 100 }, output_contract: { transparent_background: false } },
            { job_id: "lbl", placement: "inside_label", design_action: "leave_blank", must_generate: false }
          ]
        }),
        design: { artwork_brief: "abstract waves" }
      })
    );
    check(
      "tool: valid mini plan -> complete bundle with blank accounted",
      good.panels?.length === 2 &&
        good.missing_required_placements?.length === 0 &&
        good.all_required_succeeded === true
    );
    const noArgs = JSON.parse(await tool.execute({ run_id: "t5" }));
    check("tool: no plan and no jobs -> structured error", typeof noArgs.error === "string");
  }

  // --- H. Prompt safety -------------------------------------------------------
  section("H. Prompt safety");
  {
    const media = new StubMedia();
    const capture: string[] = [];
    const spy: MediaLike = {
      ...media,
      generateImage: async (params) => {
        capture.push(params.positivePrompt);
        return media.generateImage(params);
      },
      removeBackground: media.removeBackground.bind(media),
      upscale: media.upscale.bind(media),
      uploadImage: media.uploadImage.bind(media)
    };
    const jobs = [baseJob("h-front", "front"), baseJob("h-back", "back")];
    await new PanelCompiler(spy).compile("stress-prompts", jobs, design);
    const joined = capture.join("\n");
    check(
      "positive prompts never echo forbidden text",
      !joined.includes("FORBIDDENWORD") && !joined.includes("EvilBrand")
    );
    check(
      "master prompt contains no garment/panel/seam vocabulary",
      !/garment|panel|seam|unwrap|sleeve|placement/i.test(capture[0] ?? "")
    );
  }

  // --- I. Wave 2: hostile content -----------------------------------------------
  section("I. Hostile content");
  {
    const hostileDesign: DesignSpec = {
      artwork_brief: "waves " + "A".repeat(1_000_000),
      style_terms: Array.from({ length: 500 }, (_, i) => `style-${i}-${"B".repeat(500)}`),
      customer_image_captions: Array.from({ length: 50 }, () => "C".repeat(10000))
    };
    const capture: string[] = [];
    const media = new StubMedia();
    const spy: MediaLike = {
      generateImage: async (params) => {
        capture.push(params.positivePrompt);
        return media.generateImage(params);
      },
      removeBackground: media.removeBackground.bind(media),
      upscale: media.upscale.bind(media),
      uploadImage: media.uploadImage.bind(media)
    };
    const jobs = [
      baseJob("i-1", "front \"};DROP TABLE;--" + "Z".repeat(20000)),
      baseJob("i-2", "🔥🧵" + "‮".repeat(50)) // emoji + RTL override spam
    ];
    try {
      const result = await new PanelCompiler(spy).compile("stress-hostile", jobs, hostileDesign);
      check("hostile content: total accounting", accounted(jobs, result.panels));
      check(
        "hostile content: prompts stay bounded",
        capture.every((prompt) => prompt.length < 12000),
        `max prompt ${Math.max(...capture.map((p) => p.length))}`
      );
    } catch (error) {
      check("hostile content: must not throw", false, (error as Error).message.slice(0, 120));
    }
  }

  // --- J. Wave 2: mirror cycles + blank sources ------------------------------------
  section("J. Mirror cycles");
  {
    const cycle = [
      baseJob("j-a", "sleeve_left", { design_action: "mirror_from_pair", source_job_id: "j-b" }),
      baseJob("j-b", "sleeve_right", { design_action: "mirror_from_pair", source_job_id: "j-a" })
    ];
    const cycleResult = await new PanelCompiler(new StubMedia()).compile("stress-mirror-cycle", cycle, design);
    check(
      "mirror cycle: both accounted as honest failures",
      accounted(cycle, cycleResult.panels) &&
        cycleResult.panels.every((panel) => panel.status === "failed") &&
        !cycleResult.all_required_succeeded
    );

    const blankSource = [
      baseJob("j-blank", "sleeve_right", { design_action: "leave_blank", must_generate: false }),
      baseJob("j-mir", "sleeve_left", { design_action: "mirror_from_pair", source_job_id: "j-blank" })
    ];
    const blankResult = await new PanelCompiler(new StubMedia()).compile(
      "stress-mirror-blank",
      blankSource,
      design
    );
    check(
      "mirror of blank source: accounted, mirror fails honestly",
      accounted(blankSource, blankResult.panels) &&
        blankResult.panels.find((panel) => panel.job_id === "j-mir")?.status === "failed"
    );
  }

  // --- K. Wave 2: degenerate pattern scales -----------------------------------------
  section("K. Degenerate pattern scales");
  {
    for (const tileInches of [0, -3, 1e9, Number.NaN]) {
      const jobs = [
        baseJob("k-f", "front", { design_action: "repeat_pattern" }),
        baseJob("k-b", "back", { design_action: "repeat_pattern" })
      ];
      try {
        const result = await new PanelCompiler(new StubMedia()).compile(
          `stress-tile-${tileInches}`,
          jobs,
          { ...design, pattern_tile_inches: tileInches }
        );
        check(`tile inches ${tileInches}: total accounting`, accounted(jobs, result.panels));
      } catch (error) {
        check(`tile inches ${tileInches}: must not throw`, false, (error as Error).message.slice(0, 120));
      }
    }
  }

  // --- L. Wave 2: concurrency ---------------------------------------------------------
  section("L. Concurrency");
  {
    const compiler = new PanelCompiler(new StubMedia());
    const runs = await Promise.all(
      ["c1", "c2", "c3"].map((id) =>
        compiler.compile(
          `stress-conc-${id}`,
          [baseJob(`${id}-front`, "front"), baseJob(`${id}-back`, "back")],
          { ...design, artwork_brief: `design ${id}` }
        )
      )
    );
    check(
      "3 concurrent compiles on one compiler: all complete, no cross-run bleed",
      runs.every(
        (result, i) =>
          result.panels.length === 2 &&
          result.panels.every((panel) => panel.job_id.startsWith(`c${i + 1}-`))
      )
    );
  }

  // --- M. Wave 2: oversized plan JSON ---------------------------------------------------
  section("M. Oversized plan JSON");
  {
    const tool = createGeneratePanelArtworkBundleTool(new StubMedia() as unknown as RunwareMedia);
    const huge = JSON.parse(
      await tool.execute({ run_id: "m1", surface_plan_json: "x".repeat(4_000_001) })
    );
    check("4MB+ plan JSON -> structured error", /safety limit/.test(huge.error ?? ""));
  }

  console.log(`\n${checks} checks, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
