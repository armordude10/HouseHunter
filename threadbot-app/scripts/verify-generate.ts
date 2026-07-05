/**
 * Verify the /generate contract end to end: returns { variations: [{id, image}] }
 * with real preview image URLs. count=1 to keep spend down.
 *
 *   node --import tsx scripts/verify-generate.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import type { CatalogProduct } from "../src/core/ai.js";
import { OpenAIBrain } from "../src/core/ai.js";
import { OpenAIEmbedder } from "../src/core/embeddings.js";
import { generateVariations } from "../src/core/generate.js";
import { SupabaseVectorRetriever } from "../src/core/retriever.js";
import { SupabaseImageStore, SupabaseSpecStore, createSupabase } from "../src/core/supabaseStore.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const catalog = JSON.parse(
  await readFile(join(process.cwd(), "data/catalog.json"), "utf8")
) as CatalogProduct[];

const deps = {
  brain: new OpenAIBrain(config.openai.apiKey, config.openai.textModel, config.openai.imageModel, config.openai.imageSize),
  provider: new PrintfulProvider(config.printful.apiKey, config.printful.storeId),
  specs: new SupabaseSpecStore(sb),
  images: new SupabaseImageStore(sb, config.supabase.bucket),
  retriever: new SupabaseVectorRetriever(sb, new OpenAIEmbedder(config.openai.apiKey, config.openai.embeddingModel), catalog),
  providerName: "printful",
};

const result = await generateVariations(deps, {
  prompt: "a minimalist mountain range line-art badge, no text",
  count: 1,
});
console.log("GENERATE RESULT:", JSON.stringify(result, null, 2));
console.log(
  result.variations.length && result.variations.every((v) => v.image)
    ? "\nGENERATE OK (contract { variations: [{id, image}] } satisfied)"
    : "\nGENERATE returned null image(s)"
);
