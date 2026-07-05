/**
 * Show the real PANEL structure of products: every placement (panel) and its
 * printfile size/aspect, so design generation can fit each panel correctly.
 *   node --import tsx scripts/probe-panels.ts
 */

import { config } from "../src/config.js";

const headers = {
  Authorization: `Bearer ${config.printful.apiKey}`,
  "X-PF-Store-ID": config.printful.storeId,
};

const all: any[] = (await (await fetch("https://api.printful.com/products", { headers })).json()).result ?? [];
const tapestry = all.find((p) => /wall tapestry/i.test(p.title));
const poster = all.find((p) => /enhanced matte.*poster|poster/i.test(p.title));

const ids = [tapestry?.id, poster?.id, 71, 918, 1367, 198, 189].filter(Boolean);

for (const id of ids) {
  const pr: any = (await (await fetch(`https://api.printful.com/products/${id}`, { headers })).json()).result;
  const techs = (pr.product?.techniques ?? []).map((t: any) => t.key);
  const tech = ((pr.product?.techniques ?? []).find((t: any) => t.is_default)?.key ?? techs[0] ?? "").toLowerCase();
  const v0 = pr.variants?.[0];

  const pfRes = await fetch(
    `https://api.printful.com/mockup-generator/printfiles/${id}?technique=${encodeURIComponent(tech)}`,
    { headers }
  );
  const pf: any = pfRes.ok ? (await pfRes.json()).result : null;

  console.log(`\n=== ${id}  ${pr.product?.title}  [tech=${tech}] ===`);
  if (!pf) {
    console.log("  printfiles ->", pfRes.status);
    continue;
  }
  console.log("  available_placements:", JSON.stringify(pf.available_placements));
  const byId: Record<number, any> = Object.fromEntries((pf.printfiles ?? []).map((f: any) => [f.printfile_id, f]));
  const vmap = (pf.variant_printfiles ?? []).find((x: any) => x.variant_id === v0?.id) ?? pf.variant_printfiles?.[0];
  console.log(`  PANELS for variant ${vmap?.variant_id}:`);
  for (const [placement, pfid] of Object.entries(vmap?.placements ?? {})) {
    const f = byId[pfid as number];
    if (f) console.log(`    ${placement.padEnd(16)} ${f.width}x${f.height}  aspect ${(f.width / f.height).toFixed(2)}  dpi ${f.dpi}`);
  }
}
