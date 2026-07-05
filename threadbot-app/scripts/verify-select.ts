/**
 * Cheap selection check: for a batch of prompts, print the product the pipeline picks
 * (no art generation, no mockups). Tests "any prompt -> the exact product".
 *   node --import tsx scripts/verify-select.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import { OpenAIBrain, type CatalogProduct } from "../src/core/ai.js";
import { OpenAIEmbedder } from "../src/core/embeddings.js";
import { SupabaseVectorRetriever } from "../src/core/retriever.js";
import { createSupabase } from "../src/core/supabaseStore.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const prompts = [
  "a vaporwave cassette tape with palm trees",
  "comfy leggings with an all over galaxy print",
  "a tote bag covered in lemons",
  "a hoodie that says stay weird",
  "an all over koi fish jersey",
  "a coffee mug with a grumpy cat",
  "a beanie with a mountain range",
  "a phone case with pink marble",
  "minimalist line art of a wolf howling",
  "a tank top with flames",
];

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const catalog = JSON.parse(await readFile(join(process.cwd(), "data/catalog.json"), "utf8")) as CatalogProduct[];
const brain = new OpenAIBrain(config.openai.apiKey, config.openai.textModel, config.openai.imageModel, config.openai.imageSize);
const retriever = new SupabaseVectorRetriever(
  sb,
  new OpenAIEmbedder(config.openai.apiKey, config.openai.embeddingModel),
  catalog
);
const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);

for (const prompt of prompts) {
  const candidates = await retriever.retrieve(prompt, 12);
  const u = await brain.understandAndSelect({ prompt, catalog: candidates });
  const product = candidates.find((p) => p.id === u.neutralProductId);
  const pid = product?.providers.printful?.productId;
  let tech = "?";
  try {
    if (pid != null) tech = (await provider.getProductTruth(pid)).technique;
  } catch {}
  console.log(`"${prompt}"\n   -> ${product?.name ?? u.neutralProductId}  [${tech}]  color=${u.color}  style=${u.designStyle}`);
}
