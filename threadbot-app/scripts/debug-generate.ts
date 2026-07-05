import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import { OpenAIBrain } from "../src/core/ai.js";
import { PrintfulProvider } from "../src/providers/printful.js";
import { generatePreview } from "../src/core/preview.js";
import { SupabaseImageStore, SupabaseSpecStore, createSupabase } from "../src/core/supabaseStore.js";
import { SupabaseVectorRetriever } from "../src/core/retriever.js";
import { OpenAIEmbedder } from "../src/core/embeddings.js";

const catalog = JSON.parse(await readFile(join(process.cwd(), "data/catalog.json"), "utf8"));
const brain = new OpenAIBrain(
  config.openai.apiKey,
  config.openai.textModel,
  config.openai.imageModel,
  config.openai.imageSize
);
const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);
const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const specs = new SupabaseSpecStore(sb);
const images = new SupabaseImageStore(sb, config.supabase.bucket);
const embedder = new OpenAIEmbedder(config.openai.apiKey, config.openai.embeddingModel);
const retriever = new SupabaseVectorRetriever(sb, embedder, catalog);
const deps = { brain, provider, specs, images, retriever, providerName: "printful" as const };

const prompt = process.argv[2] || "an all over print shirt with a koi fish pattern";
let imageUrls: string[] | undefined;
if (process.env.IMG) {
  const buf = await readFile(process.env.IMG);
  const ext = process.env.IMG.split(".").pop()!.toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  imageUrls = [`data:${mime};base64,${buf.toString("base64")}`];
  console.log("with attached image (data URL,", buf.length, "bytes,", mime + ")");
}
console.log("PROMPT:", prompt);
try {
  const r = await generatePreview(deps, { prompt, imageUrls });
  console.log("OK ->", JSON.stringify(r, null, 2));
} catch (e: any) {
  console.error("THREW:", e?.message);
  if (e?.status) console.error("status:", e.status);
  if (e?.response?.data) console.error("response.data:", JSON.stringify(e.response.data));
  if (e?.error) console.error("error:", JSON.stringify(e.error));
  console.error("stack:", e?.stack);
}
process.exit(0);
