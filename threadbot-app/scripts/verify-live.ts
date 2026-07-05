/**
 * Live verification (read-only on Printful — NO order is confirmed):
 *   1. catalog product ids resolve + have mockup geometry
 *   2. a real preview renders into Supabase Storage
 *   3. the order maps cleanly and Printful accepts it for a cost estimate
 *
 *   node --import tsx scripts/verify-live.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import type { CatalogProduct } from "../src/core/ai.js";
import { OpenAIBrain } from "../src/core/ai.js";
import { OpenAIEmbedder } from "../src/core/embeddings.js";
import { buildNeutralOrder } from "../src/core/orderMapper.js";
import { generatePreview } from "../src/core/preview.js";
import { SupabaseVectorRetriever } from "../src/core/retriever.js";
import { SupabaseImageStore, SupabaseSpecStore, createSupabase } from "../src/core/supabaseStore.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const catalog = JSON.parse(
  await readFile(join(process.cwd(), "data/catalog.json"), "utf8")
) as CatalogProduct[];

const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);

console.log("== 1. Verify catalog against live Printful ==");
for (const p of catalog) {
  const pid = p.providers.printful!.productId;
  try {
    const v = await provider.resolveVariant(pid, p.defaultColor);
    const g = await provider.getPlacementGeometry(pid, v.providerVariantId, p.primaryPlacement, p.technique);
    console.log(
      `  OK   ${p.id} (printful ${pid}) -> variant ${v.providerVariantId} ${v.color}/${v.size}; printArea ${g.printAreaWidth}x${g.printAreaHeight}`
    );
  } catch (e) {
    console.log(`  FAIL ${p.id} (printful ${pid}): ${(e as Error).message}`);
  }
}

console.log("\n== 2. Real preview into Supabase ==");
const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const specs = new SupabaseSpecStore(sb);
const images = new SupabaseImageStore(sb, config.supabase.bucket);
const brain = new OpenAIBrain(
  config.openai.apiKey,
  config.openai.textModel,
  config.openai.imageModel,
  config.openai.imageSize
);
const retriever = new SupabaseVectorRetriever(sb, new OpenAIEmbedder(config.openai.apiKey, config.openai.embeddingModel), catalog);

const preview = await generatePreview(
  { brain, provider, specs, images, retriever, providerName: "printful" },
  { prompt: "a vintage-style skull badge for a black t-shirt, muted earth tones, no text" }
);
console.log("  PREVIEW:", preview);

console.log("\n== 3. Order mapping + cost estimate (NO order placed) ==");
if (preview.status === "ready" && preview.designId) {
  const spec = await specs.get(preview.designId);
  const variant = await provider.resolveVariant(spec!.providerBinding.providerProductId, spec!.color, "L");
  const order = buildNeutralOrder({
    spec: spec!,
    recipient: { name: "Doug Test", address1: "456 Main St", city: "Peoria", country_code: "US", state_code: "IL", zip: "61602" },
    boundVariantId: variant.providerVariantId,
    quantity: 1,
    externalId: `verify_${Date.now()}`,
  });
  console.log("  bound variant (size L):", variant.providerVariantId, `${variant.color}/${variant.size}`);
  console.log("  order files:", JSON.stringify(order.items[0].files));
  try {
    const est = await provider.estimateCost(order);
    console.log("  ESTIMATE:", est);
  } catch (e) {
    console.log("  estimate failed:", (e as Error).message);
  }
}

console.log("\nVERIFY DONE");
