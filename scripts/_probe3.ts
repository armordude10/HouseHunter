import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const text = (r: any) => (Array.isArray(r.content) ? r.content.map((c: any) => c.text ?? "").join("") : String(r.content));
async function main() {
  const pf = new Client({ name: "probe3", version: "1.0.0" });
  await pf.connect(new StreamableHTTPClientTransport(new URL("https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp")));
  for (const id of [162, 165, 227, 146, 380, 344]) {
    try {
      const r = await pf.callTool({ name: "list_printful_mockup_styles", arguments: { product_id: id, limit: 3 } });
      console.log(`\n--- product ${id}: ${text(r).slice(0, 700)}`);
    } catch (e) { console.log(`\n--- product ${id} ERROR: ${(e as Error).message.slice(0, 200)}`); }
  }
  await pf.close();
}
main().catch(e => { console.error(e); process.exit(1); });
