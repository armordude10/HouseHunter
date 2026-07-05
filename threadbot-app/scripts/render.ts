/**
 * Render ONE prompt verbatim through the real pipeline and save the resulting
 * preview locally. Used for honest, prompt-controlled testing.
 *   node --import tsx scripts/render.ts "<your exact prompt>"
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import type { CatalogProduct } from "../src/core/ai.js";
import { OpenAIBrain } from "../src/core/ai.js";
import { OpenAIEmbedder } from "../src/core/embeddings.js";
import { generatePreview } from "../src/core/preview.js";
import { SupabaseVectorRetriever } from "../src/core/retriever.js";
import { SupabaseImageStore, SupabaseSpecStore, createSupabase } from "../src/core/supabaseStore.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) throw new Error('usage: render.ts "<prompt>"');

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

const r = await generatePreview(deps, { prompt });
console.log(
  JSON.stringify(
    { prompt, status: r.status, product: r.product, color: r.color, image: r.previewImageUrl, message: r.message },
    null,
    2
  )
);
if (r.previewImageUrl) {
  const buf = Buffer.from(await (await fetch(r.previewImageUrl)).arrayBuffer());
  const out = `public/render-${(r.designId || "x").slice(0, 8)}.jpg`;
  await writeFile(out, buf);
  console.log("saved", out);
}
