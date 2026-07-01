import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function probe(label: string, url: string) {
  const client = new Client({ name: `probe-${label}`, version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    console.log(`\n=== ${label} (${tools.tools.length} tools) ===`);
    for (const t of tools.tools) {
      console.log(`- ${t.name}`);
      console.log(`  schema: ${JSON.stringify(t.inputSchema).slice(0, 600)}`);
    }
    await client.close();
  } catch (e) {
    console.log(`\n=== ${label} FAILED: ${(e as Error).message}`);
  }
}
async function main() {
  await probe("printful_mockups", "https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp");
  await probe("product_intelligence", "https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp");
}
main();
