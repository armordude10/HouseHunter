/**
 * Prove the REAL Printful mockup path on an all-over product: take an existing
 * generated design and render it through Printful's mockup generator (not a local
 * composite) so we get an actual garment image.
 *   node --import tsx scripts/real-mockup.ts [productId] [variantId]
 */

import { writeFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { createSupabase } from "../src/core/supabaseStore.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const productId = Number(process.argv[2] ?? 189); // default: All-Over Print Leggings
const variantId = Number(process.argv[3] ?? 7679); // White / L

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);

const { data } = await sb
  .from("design_specs")
  .select("spec")
  .order("created_at", { ascending: false })
  .limit(1);
const fileUrl = (data?.[0]?.spec as any)?.placements?.[0]?.fileUrl;
if (!fileUrl) throw new Error("no prior design art found");
console.log("design art:", fileUrl);

const { technique, placements } = await provider.getProductTruth(productId);
const placement = placements[0] ?? "front";
console.log(`product ${productId} technique=${technique} placements=${JSON.stringify(placements)} -> using "${placement}"`);

const geo = await provider.getPlacementGeometry(productId, variantId, placement, technique);
const position = {
  area_width: geo.printAreaWidth,
  area_height: geo.printAreaHeight,
  width: geo.printAreaWidth,
  height: geo.printAreaHeight,
  top: 0,
  left: 0,
};

console.log("rendering REAL Printful mockup (async task)...");
const url = await provider.renderMockup({ productId, variantId, technique, files: [{ placement, fileUrl, position }] });
console.log("REAL MOCKUP URL:", url);

const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
await writeFile("public/real-aop-mockup.jpg", buf);
console.log("saved public/real-aop-mockup.jpg");
