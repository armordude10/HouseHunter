import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const text = (r: any) => (Array.isArray(r.content) ? r.content.map((c: any) => c.text ?? "").join("") : String(r.content));
async function main() {
  const pf = new Client({ name: "probe4", version: "1.0.0" });
  await pf.connect(new StreamableHTTPClientTransport(new URL("https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp")));
  const ids = Array.from({ length: 320 }, (_, i) => 150 + i);
  const results: string[] = [];
  let inFlight: Promise<void>[] = [];
  const runOne = async (id: number) => {
    try {
      const r = await pf.callTool({ name: "list_printful_mockup_styles", arguments: { product_id: id, limit: 50 } });
      const body = JSON.parse(text(r));
      const placements = (body.data ?? []).map((d: any) => `${d.placement}:${d.technique}`);
      const isAop = placements.some((p: string) => /sublimation|cut|all_over/.test(p)) ||
                    (body.data ?? []).some((d: any) => /sleeve|hood|leg/.test(d.placement)) && placements.length >= 3;
      if (isAop) results.push(`product ${id}: ${placements.join(", ")}`);
    } catch { /* 404 etc */ }
  };
  for (const id of ids) {
    inFlight.push(runOne(id));
    if (inFlight.length >= 6) { await Promise.all(inFlight); inFlight = []; }
  }
  await Promise.all(inFlight);
  console.log(results.join("\n"));
  await pf.close();
}
main().catch(e => { console.error(e); process.exit(1); });
