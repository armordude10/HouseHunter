/**
 * Prove the multi-panel engine: design a koi all-over pattern across EVERY panel of
 * a cut-sew jersey (front/back/sleeves/yoke) and save all mockup views.
 *   node --import tsx scripts/verify-panels.ts [productId]
 */

import { writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { OpenAIBrain } from "../src/core/ai.js";
import { sha256Hex } from "../src/core/hash.js";
import { fillPrintArea } from "../src/core/position.js";
import { SupabaseImageStore, createSupabase } from "../src/core/supabaseStore.js";
import { classifyMode, makeSeamless, panelScale, selectDesignPanels, sliceSceneToPanels, tileFill } from "../src/core/surface.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const productId = Number(process.argv[2] ?? 918); // AOP American Football Jersey

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const images = new SupabaseImageStore(sb, config.supabase.bucket);
const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);
const brain = new OpenAIBrain(config.openai.apiKey, config.openai.textModel, config.openai.imageModel, config.openai.imageSize);

const truth = await provider.getProductTruth(productId);
const variant = await provider.resolveVariant(productId, truth.defaultColor);
const panels = await provider.getPanels(productId, truth.technique, variant.providerVariantId);
const mode = classifyMode(truth.technique);
const design = selectDesignPanels(panels, mode);
console.log(`product ${productId} technique=${truth.technique} mode=${mode}`);
console.log("design panels:", design.map((p) => `${p.placement}(${p.width}x${p.height})`).join(", "));

const styleArg = process.argv[3] === "scene" ? "scene" : "pattern";
const master = await brain.generateArtwork(
  styleArg === "scene"
    ? "a single giant majestic koi fish swimming among lotus flowers, one centered hero subject, painted scene that extends to every edge, traditional Japanese ink, no text"
    : "a seamless all-over koi fish and lotus flower pattern, traditional Japanese ink style, edge to edge, no text"
);

const scale = panelScale(design);
const sliceMap = styleArg === "scene" ? await sliceSceneToPanels(master.buffer, design, scale) : null;
const seamless = styleArg === "scene" ? null : await makeSeamless(master.buffer);
console.log("design style:", styleArg);
const files = [];
for (const panel of design) {
  const buf = sliceMap ? sliceMap.get(panel.placement)! : await tileFill(seamless!, panel, scale);
  const sha = sha256Hex(buf);
  const url = await images.put(buf, `panel-${productId}-${panel.placement}-${sha.slice(0, 8)}.jpg`, "image/jpeg");
  files.push({ placement: panel.placement, fileUrl: url, position: fillPrintArea(panel.width, panel.height) });
}
console.log(`submitting ${files.length} panel files to the mockup generator...`);

const views = await provider.renderMockupViews({
  productId,
  variantId: variant.providerVariantId,
  technique: truth.technique,
  files,
});
console.log(`mockup views returned: ${views.length}`);
for (let i = 0; i < Math.min(views.length, 4); i++) {
  const buf = Buffer.from(await (await fetch(views[i])).arrayBuffer());
  await writeFile(`public/verify-panels-${i}.jpg`, buf);
  console.log(`saved public/verify-panels-${i}.jpg  <-  ${views[i]}`);
}
