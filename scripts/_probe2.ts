import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const text = (r: any) => (Array.isArray(r.content) ? r.content.map((c: any) => c.text ?? "").join("") : String(r.content));

async function main() {
  const pf = new Client({ name: "probe2-pf", version: "1.0.0" });
  await pf.connect(new StreamableHTTPClientTransport(new URL("https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp")));
  const tools = await pf.listTools();
  const create = tools.tools.find(t => t.name === "create_and_wait_for_printful_mockups");
  console.log("FULL create schema:\n", JSON.stringify(create?.inputSchema, null, 1).slice(0, 2500));

  const pi = new Client({ name: "probe2-pi", version: "1.0.0" });
  await pi.connect(new StreamableHTTPClientTransport(new URL("https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp")));
  for (const q of ["all-over print hoodie", "all-over print t-shirt", "leggings"]) {
    const r = await pi.callTool({ name: "search_products", arguments: { query: q, limit: 5 } });
    console.log(`\n--- search: ${q}\n${text(r).slice(0, 1500)}`);
  }
  await pf.close(); await pi.close();
}
main().catch(e => { console.error(e); process.exit(1); });
