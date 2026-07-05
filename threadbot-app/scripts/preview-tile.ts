/**
 * Cheap flat test of the seamless tiler (no Printful mockup): generate a pattern,
 * make it seamless, tile a front-sized panel, and save the flat result to inspect.
 *   node --import tsx scripts/preview-tile.ts
 */

import { writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { OpenAIBrain } from "../src/core/ai.js";
import { makeSeamless, tileFill } from "../src/core/surface.js";

const brain = new OpenAIBrain(
  config.openai.apiKey,
  config.openai.textModel,
  config.openai.imageModel,
  config.openai.imageSize
);

const master = await brain.generateArtwork(
  "a seamless all-over koi fish and lotus flower pattern, traditional Japanese ink style, edge to edge, no text"
);
const seamless = await makeSeamless(master.buffer);
const buf = await tileFill(seamless, { placement: "front", width: 7200, height: 5550, dpi: 150 }, 0.5);
await writeFile("public/tile-test.jpg", buf);
console.log("saved public/tile-test.jpg");
