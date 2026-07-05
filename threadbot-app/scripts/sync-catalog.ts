/**
 * Sync the ENTIRE live Printful catalog into Supabase `catalog_products` with
 * embeddings, so product selection ranges over every product (not a seed list).
 * Per-product technique/placement/color are resolved live at selection time.
 *   node --import tsx scripts/sync-catalog.ts
 */

import OpenAI from "openai";
import { config } from "../src/config.js";
import { createSupabase } from "../src/core/supabaseStore.js";

if (!config.supabase.url || !config.supabase.serviceRoleKey) throw new Error("Supabase env required");
if (!config.openai.apiKey) throw new Error("OPENAI_API_KEY required");
if (!config.printful.apiKey) throw new Error("PRINTFUL_API_KEY required");

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const openai = new OpenAI({ apiKey: config.openai.apiKey });
const headers = {
  Authorization: `Bearer ${config.printful.apiKey}`,
  "X-PF-Store-ID": config.printful.storeId,
};

console.log("fetching full Printful catalog...");
const all: any[] = (await (await fetch("https://api.printful.com/products", { headers })).json()).result ?? [];
const active = all.filter((p) => !p.is_discontinued);
console.log(`catalog: ${all.length} products (${active.length} active)`);

const rows = active.map((p) => {
  const text = `${p.title} ${p.type_name}`.trim();
  const keywords = Array.from(
    new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2))
  ).slice(0, 24);
  return {
    id: `pf-${p.id}`,
    name: p.title,
    keywords,
    default_color: "",
    is_default: p.id === 71, // basic unisex tee, the fallback when a prompt is vague
    technique: "", // resolved live per selection
    primary_placement: "", // resolved live per selection
    providers: { printful: { productId: p.id } },
    search_text: `${text} ${keywords.join(" ")}`,
    embedding: [] as number[],
  };
});

console.log("clearing old catalog rows...");
await sb.from("catalog_products").delete().neq("id", "");

const BATCH = 96;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const emb = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: batch.map((r) => r.search_text),
  });
  batch.forEach((r, j) => (r.embedding = emb.data[j].embedding as number[]));
  const { error } = await sb.from("catalog_products").upsert(batch);
  if (error) throw new Error(error.message);
  console.log(`embedded + upserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
}

console.log(`\nSynced ${rows.length} products into catalog_products.`);
