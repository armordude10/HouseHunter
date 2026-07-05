/**
 * Live fusion check: feed an image into the prompt and confirm generateArtwork uses
 * images.edit (fusion) rather than text-to-image. Reuses the most recent generated art
 * as the stand-in "customer upload" so no extra hosting is needed.
 *
 *   node --import tsx scripts/verify-fusion.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import type { CatalogProduct } from "../src/core/ai.js";
import { OpenAIBrain } from "../src/core/ai.js";
import { OpenAIEmbedder } from "../src/core/embeddings.js";
import { generatePreview } from "../src/core/preview.js";
import { SupabaseVectorRetriever } from "../src/core/retriever.js";
import { SupabaseImageStore, SupabaseSpecStore, createSupabase } from "../src/core/supabaseStore.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const { data, error } = await sb
  .from("design_specs")
  .select("spec")
  .order("created_at", { ascending: false })
  .limit(1);
if (error) throw new Error(error.message);
const inputUrl = (data?.[0]?.spec as any)?.placements?.[0]?.fileUrl;
if (!inputUrl) throw new Error("No prior art to use as input — run scripts/verify-live.ts first.");
console.log("input image (stand-in for a customer upload):", inputUrl);

const catalog = JSON.parse(
  await readFile(join(process.cwd(), "data/catalog.json"), "utf8")
) as CatalogProduct[];
const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);
const specs = new SupabaseSpecStore(sb);
const images = new SupabaseImageStore(sb, config.supabase.bucket);
const brain = new OpenAIBrain(
  config.openai.apiKey,
  config.openai.textModel,
  config.openai.imageModel,
  config.openai.imageSize
);
const retriever = new SupabaseVectorRetriever(
  sb,
  new OpenAIEmbedder(config.openai.apiKey, config.openai.embeddingModel),
  catalog
);

const res = await generatePreview(
  { brain, provider, specs, images, retriever, providerName: "printful" },
  {
    prompt: "use the attached image but reimagine it as bold retro 80s synthwave with neon gradients, for a black t-shirt",
    imageUrls: [inputUrl],
  }
);
console.log("FUSION PREVIEW:", res);
console.log("\nFUSION VERIFY DONE");
