import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const text = (r: any) => (Array.isArray(r.content) ? r.content.map((c: any) => c.text ?? "").join("") : String(r.content));
async function main() {
  const pf = new Client({ name: "probe5", version: "1.0.0" });
  await pf.connect(new StreamableHTTPClientTransport(new URL("https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp")));
  for (const id of [388, 257, 242]) {
    const r = await pf.callTool({ name: "list_printful_mockup_styles", arguments: { product_id: id, limit: 60 } });
    const body = JSON.parse(text(r));
    console.log(`\n--- product ${id}`);
    for (const d of body.data ?? []) {
      const styles = (d.mockup_styles ?? []).slice(0, 4).map((s: any) => `${s.id}:${s.category_name}/${s.view_name}`);
      console.log(`${d.placement} [${d.technique}] ${d.print_area_width}x${d.print_area_height} @${d.dpi}dpi type=${d.print_area_type} styles: ${styles.join(" | ")}`);
    }
  }
  await pf.close();
}
main().catch(e => { console.error(e); process.exit(1); });
