/**
 * Catalog-wide analytic calibration build.
 *
 * Walks the ENTIRE Printful catalog and computes, from Printful's own
 * mockup-template data, the piece-within-canvas calibration profile for
 * every product that needs one (cut-sew / sublimation / any technique whose
 * template overlay reveals a piece region). Simple-print techniques
 * (dtg/dtfilm/embroidery) map 1:1 and get no entry — the engine's default
 * (piece == canvas) is already correct for them.
 *
 * Output: data/printful-calibration.json
 *   { "<productId>": { "<placement>": { pieceWFrac, ..., anchor? } } }
 *
 * Also validates the computed values for products 388/257/242 against the
 * hand-measured grid-mockup profiles.
 *
 * Usage: PRINTFUL_API_KEY=... npx tsx scripts/build-calibration.ts [startId]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProductCalibration } from "../src/engine/printfulTemplates.js";
import { CalibrationProfile } from "../src/engine/garmentSpace.js";

const OUT_FILE = path.resolve("data/printful-calibration.json");

const listCatalogProductIds = async (): Promise<Array<{ id: number; title: string }>> => {
  const response = await fetch("https://api.printful.com/products");
  const body = (await response.json()) as {
    result: Array<{ id: number; title: string; is_discontinued?: boolean }>;
  };
  return body.result
    .filter((product) => !product.is_discontinued)
    .map((product) => ({ id: product.id, title: product.title }));
};

const run = async () => {
  const products = await listCatalogProductIds();
  console.log(`catalog products: ${products.length}`);
  await mkdir(path.dirname(OUT_FILE), { recursive: true });

  const profiles: Record<number, CalibrationProfile> = {};
  const meta: Record<number, { title: string; techniques: string[]; calibrated: number }> = {};
  let done = 0;

  for (const product of products) {
    try {
      const result = await buildProductCalibration(product.id);
      if (result) {
        const calibratedPlacements = Object.keys(result.profile).length;
        if (calibratedPlacements > 0) {
          profiles[product.id] = result.profile;
        }
        meta[product.id] = {
          title: product.title,
          techniques: [...result.techniques],
          calibrated: calibratedPlacements
        };
        if (calibratedPlacements > 0) {
          console.log(
            `${product.id} ${product.title}: ${calibratedPlacements} placement(s) calibrated [${[...result.techniques].join(",")}]`
          );
        }
      }
    } catch (error) {
      console.log(`${product.id} ${product.title}: ERROR ${(error as Error).message}`);
    }
    done++;
    if (done % 50 === 0) console.log(`... ${done}/${products.length}`);
    await new Promise((resolve) => setTimeout(resolve, 250)); // stay well under rate limits
  }

  await writeFile(
    OUT_FILE,
    JSON.stringify({ generated_at: new Date().toISOString(), profiles, meta }, null, 1)
  );
  console.log(
    `\nWrote ${OUT_FILE}: ${Object.keys(profiles).length} calibrated products of ${products.length}`
  );

  // Validation against hand-measured grid-mockup profiles.
  const measured: Record<string, Record<string, [number, number, number, number]>> = {
    "388": {
      front: [0.64, 0.78, 0.5, 0.54],
      back: [0.64, 0.86, 0.5, 0.51],
      pocket: [0.31, 0.2, 0.5, 0.575]
    },
    "257": { default: [0.66, 0.8, 0.5, 0.55] },
    "242": { default: [0.56, 0.92, 0.5, 0.5] }
  };
  console.log("\nValidation (analytic vs hand-measured):");
  for (const [pid, placements] of Object.entries(measured)) {
    for (const [placement, [w, h, cx, cy]] of Object.entries(placements)) {
      const computed = profiles[Number(pid)]?.[placement];
      if (!computed) {
        console.log(`  ${pid}/${placement}: NOT COMPUTED`);
        continue;
      }
      console.log(
        `  ${pid}/${placement}: computed w${computed.pieceWFrac} h${computed.pieceHFrac} ` +
          `cx${computed.pieceCxFrac} cy${computed.pieceCyFrac} | measured w${w} h${h} cx${cx} cy${cy}`
      );
    }
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
