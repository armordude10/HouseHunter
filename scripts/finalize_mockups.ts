/**
 * Finalize official Printful mockups:
 *  - Pull true mockup renders from catalog_variant_mockups in the saved task
 *    responses (tee + leggings completed on the first pass).
 *  - Retry the hoodie mockup task (Printful returned a transient internal
 *    server error) reusing the exact placement file URLs already submitted.
 *  - Rebuild the gallery with ONLY official Printful mockup renders.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const OUT_DIR = path.resolve("out/printful-mockups");
const MOCKUPS_MCP = "https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp";

const mcpText = (r: unknown): string => {
  const content = (r as { content?: Array<{ text?: string }> }).content;
  return Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : String(content);
};

interface MockupEntry {
  placement: string;
  style_id: number;
  mockup_url: string;
  view: string;
}

const mockupsFromTask = (task: Record<string, any>): MockupEntry[] => {
  const data = task?.waited?.task?.data?.[0] ?? task?.data?.[0] ?? task;
  const groups = data?.catalog_variant_mockups ?? [];
  const out: MockupEntry[] = [];
  for (const group of groups) for (const m of group.mockups ?? []) out.push(m);
  return out;
};

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const thumb = async (buffer: Buffer, maxW: number) =>
  sharp(buffer).resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
const b64 = (buffer: Buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`;

const TITLES: Record<string, string> = {
  hoodie: "AOP Recycled Unisex Hoodie — Printful #388, variant 18730 (White / M)",
  tee: "AOP Men's Crew Neck T-Shirt — Printful #257, variant 8852 (White / M)",
  leggings: "AOP Yoga Leggings — Printful #242, variant 8355"
};

const run = async () => {
  const mcp = new Client({ name: "threadbot-finalize", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MOCKUPS_MCP)));

  const perGarment = new Map<string, MockupEntry[]>();

  for (const name of ["hoodie", "tee", "leggings"]) {
    const saved = JSON.parse(await readFile(path.join(OUT_DIR, `${name}-task.json`), "utf8"));
    let entries = mockupsFromTask(saved);
    const status = saved?.waited?.task?.data?.[0]?.status;
    console.log(`${name}: saved task status=${status}, mockups=${entries.length}`);

    if (status !== "completed" || !entries.length) {
      // Retry with the exact placement files already submitted.
      const args = saved.args_used ?? {};
      const placementFileUrls: Record<string, string> = {};
      for (const [key, value] of Object.entries(args.placement_file_urls ?? {})) {
        placementFileUrls[key] =
          typeof value === "string" ? value : ((value as { source_url: string }).source_url ?? "");
      }
      console.log(`${name}: retrying Printful mockup task...`);
      const response = await mcp.callTool(
        {
          name: "create_and_wait_for_printful_mockups",
          arguments: {
            product_id: args.product_id,
            variant_ids: args.variant_ids,
            placement_file_urls: placementFileUrls,
            mockup_style_ids: args.mockup_style_ids,
            format: "jpg",
            mockup_width_px: 1200,
            max_attempts: 30,
            interval_seconds: 5
          }
        },
        undefined,
        { timeout: 300000 }
      );
      const raw = mcpText(response);
      await writeFile(path.join(OUT_DIR, `${name}-task-retry.json`), raw);
      const retried = JSON.parse(raw);
      entries = mockupsFromTask(retried);
      console.log(
        `${name}: retry status=${retried?.waited?.task?.data?.[0]?.status}, mockups=${entries.length}`
      );
    }
    perGarment.set(name, entries);
  }
  await mcp.close();

  // Rebuild gallery from official mockup renders only.
  const blocks: string[] = [];
  for (const [name, entries] of perGarment) {
    const cells: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      try {
        const buffer = await download(entries[i].mockup_url);
        await writeFile(path.join(OUT_DIR, `${name}-official-${entries[i].view.toLowerCase()}-${i + 1}.jpg`), buffer);
        cells.push(
          `<figure><img src="${b64(await thumb(buffer, 640))}"/><figcaption><b>${entries[i].view}</b> · style ${entries[i].style_id} · rendered by Printful Mockup Generator</figcaption></figure>`
        );
      } catch (error) {
        console.log(`${name} mockup ${i + 1} download failed: ${(error as Error).message}`);
      }
    }
    blocks.push(`
      <section>
        <h2>${TITLES[name] ?? name}</h2>
        <p class="meta">${cells.length} official Printful mockup render(s)</p>
        <div class="grid">${cells.join("") || "<p>TASK DID NOT COMPLETE — see logs</p>"}</div>
      </section>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Threadbot — Official Printful mockups (AOP live test)</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background:#121216; color:#eaeaf0; margin:0; padding:32px; }
    h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 40px; border-top: 1px solid #2c2c34; padding-top: 24px; }
    .meta { color:#8f8fa6; font-size: 13px; }
    img { border-radius: 8px; display:block; max-width: 100%; }
    .grid { display:flex; flex-wrap: wrap; gap: 16px; }
    figure { margin:0; max-width: 640px; } figcaption { font-size: 12px; color:#9a9ab0; margin-top: 6px; }
  </style></head><body>
  <h1>Threadbot — Official Printful mockups</h1>
  <p class="meta">Print files compiled by the garment-space engine on Runware.ai, mockups rendered exclusively by Printful's Mockup Generator API (v2 mockup-tasks). Every image below came from a Printful mockup task result.</p>
  ${blocks.join("\n")}
  </body></html>`;
  await writeFile(path.join(OUT_DIR, "official-mockups.html"), html);
  console.log(`Wrote ${OUT_DIR}/official-mockups.html`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
