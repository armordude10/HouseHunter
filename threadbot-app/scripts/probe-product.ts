/**
 * Probe specific Printful products for technique + placement geometry so we can add
 * them correctly (esp. all-over-print, which is not DTG).
 *   node --import tsx scripts/probe-product.ts 918 303 71 189
 */

import { config } from "../src/config.js";

const headers = {
  Authorization: `Bearer ${config.printful.apiKey}`,
  "X-PF-Store-ID": config.printful.storeId,
};

for (const id of process.argv.slice(2).map(Number)) {
  console.log(`\n===== product ${id} =====`);
  const pr: any = await (await fetch(`https://api.printful.com/products/${id}`, { headers })).json();
  const prod = pr.result?.product ?? {};
  console.log("title:", prod.title, "| type_name:", prod.type_name);
  console.log("techniques:", JSON.stringify(prod.techniques ?? "n/a"));
  const v = (pr.result?.variants ?? [])[0];
  console.log("sample variant:", v?.id, v?.color, v?.size, "| total variants:", (pr.result?.variants ?? []).length);

  const tr = await fetch(`https://api.printful.com/mockup-generator/templates/${id}`, { headers });
  if (!tr.ok) {
    console.log("templates(no technique) ->", tr.status, (await tr.text()).slice(0, 160));
    continue;
  }
  const r: any = (await tr.json()).result ?? {};
  console.log("template keys:", Object.keys(r).join(","));
  const placements = [...new Set((r.templates ?? []).map((t: any) => t.placement))];
  console.log("placements:", JSON.stringify(placements));
  const t0 = (r.templates ?? [])[0];
  if (t0)
    console.log(
      "template[0]:",
      JSON.stringify({
        placement: t0.placement,
        tW: t0.template_width,
        tH: t0.template_height,
        paW: t0.print_area_width,
        paH: t0.print_area_height,
        paT: t0.print_area_top,
        paL: t0.print_area_left,
      })
    );
}
