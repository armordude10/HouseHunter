/**
 * Explore the live Printful catalog to find real product IDs to add (AOP / cut-sew,
 * and a range of garment types) so product selection has actual variety.
 *   node --import tsx scripts/explore-catalog.ts
 */

import { config } from "../src/config.js";

const headers = {
  Authorization: `Bearer ${config.printful.apiKey}`,
  "X-PF-Store-ID": config.printful.storeId,
};

const res = await fetch("https://api.printful.com/products", { headers });
const json: any = await res.json();
const all: any[] = json.result ?? [];
console.log("total catalog products:", all.length);

const rx = /all.?over|aop|cut.?&?.?sew|sublimat/i;
const aop = all.filter((p) => rx.test(`${p.title} ${p.type_name} ${p.type}`) && !p.is_discontinued);
console.log(`\n=== ALL-OVER / cut-sew candidates (${aop.length}) ===`);
for (const p of aop.slice(0, 30)) {
  console.log(`  id=${p.id}  [${p.type_name}]  ${p.title}  (variants:${p.variant_count})`);
}

console.log("\n=== one product per type (for range) ===");
const seen = new Set<string>();
for (const p of all) {
  if (p.is_discontinued || seen.has(p.type_name)) continue;
  seen.add(p.type_name);
  console.log(`  type="${p.type_name}"  e.g. id=${p.id}  ${p.title}`);
}
