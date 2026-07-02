import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const text = (r: any) => (Array.isArray(r.content) ? r.content.map((c: any) => c.text ?? "").join("") : String(r.content));
async function main() {
  const pi = new Client({ name: "probe6", version: "1.0.0" });
  await pi.connect(new StreamableHTTPClientTransport(new URL("https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp")));
  for (const args of [
    { name: "get_template_geometry", arguments: { product_id: 388, placement: "front" } },
    { name: "get_template_geometry", arguments: { product_id: 388, placement: "pocket" } }
  ]) {
    try {
      const r = await pi.callTool(args as any);
      console.log(`--- ${JSON.stringify(args.arguments)}:\n${text(r).slice(0, 1200)}\n`);
    } catch (e) { console.log(`--- ${JSON.stringify(args.arguments)} ERROR: ${(e as Error).message.slice(0, 160)}`); }
  }
  await pi.close();
}
main().catch(e => { console.error(e); process.exit(1); });
