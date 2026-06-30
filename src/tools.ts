import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * TOOL LAYER
 *
 * In the original OpenAI-Agents implementation the Threadbot MCP servers were
 * attached with `hostedMcpTool(...)`, which relies on OpenAI's Responses API
 * hosting the MCP connection server-side. Runware's LLM layer is a
 * Chat-Completions-style `textInference` task, so there is no hosted-MCP
 * passthrough. To run those exact same tools against Runware-hosted models we
 * connect to each MCP server CLIENT-SIDE here (Streamable HTTP transport) and
 * expose its tools to the model as ordinary function tools. The engine
 * (runware-engine.ts) runs the tool-call loop locally.
 *
 * The server URLs and the per-agent allowed-tool lists are preserved verbatim
 * from the original workflow — only the transport changed.
 */

// A normalized tool the Runware engine can advertise and invoke.
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input arguments. */
  parameters: Record<string, any>;
  /** Executes the tool and returns a string result for the model. */
  invoke(args: Record<string, any>): Promise<string>;
}

// -----------------------------------------------------------------------------
// Threadbot MCP server registry (verbatim URLs from the original workflow).
// -----------------------------------------------------------------------------
export const THREADBOT_MCP_SERVERS = {
  threadbot_policy_mcp: "https://threadbot-policy-mcp-2uts5km5aq-uc.a.run.app/mcp",
  threadbot_product_intelligence_mcp:
    "https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp",
  threadbot_pricing_agentbuilder_mcp:
    "https://threadbot-pricing-agentbuilder-mcp-2uts5km5aq-uc.a.run.app/mcp",
  threadbot_printful_mockups_mcp:
    "https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp",
} as const;

export type ThreadbotServerLabel = keyof typeof THREADBOT_MCP_SERVERS;

/** A request for tools: the MCP server and the subset of its tools to expose. */
export interface McpToolRef {
  serverLabel: ThreadbotServerLabel;
  serverUrl: string;
  allowedTools: string[];
}

// -----------------------------------------------------------------------------
// MCP hub: lazily connects to each server, caches the client + tool listing.
// -----------------------------------------------------------------------------
interface CachedServer {
  client: Client;
  toolsByName: Map<string, { description: string; inputSchema: Record<string, any> }>;
}

export class McpHub {
  private servers = new Map<string, Promise<CachedServer>>();
  private bearer?: string;

  constructor(opts: { bearer?: string } = {}) {
    this.bearer = opts.bearer;
  }

  private connect(url: string): Promise<CachedServer> {
    let pending = this.servers.get(url);
    if (pending) return pending;

    pending = (async () => {
      const requestInit: RequestInit | undefined = this.bearer
        ? { headers: { Authorization: `Bearer ${this.bearer}` } }
        : undefined;

      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
      const client = new Client(
        { name: "threadbot-runware-backend", version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(transport);

      const listed = await client.listTools();
      const toolsByName = new Map<string, { description: string; inputSchema: Record<string, any> }>();
      for (const t of listed.tools) {
        toolsByName.set(t.name, {
          description: t.description ?? "",
          inputSchema: (t.inputSchema as Record<string, any>) ?? { type: "object", properties: {} },
        });
      }
      return { client, toolsByName };
    })();

    this.servers.set(url, pending);
    return pending;
  }

  /**
   * Build the AgentTool[] for a set of MCP tool refs. Tool names are unique
   * across the Threadbot servers, so the model sees them by their real names
   * exactly as the agent instructions reference them.
   */
  async buildTools(refs: McpToolRef[]): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    const seen = new Set<string>();

    for (const ref of refs) {
      const server = await this.connect(ref.serverUrl);
      for (const name of ref.allowedTools) {
        if (seen.has(name)) continue;
        seen.add(name);

        const spec = server.toolsByName.get(name);
        const description = spec?.description ?? `${ref.serverLabel}.${name}`;
        const parameters = spec?.inputSchema ?? { type: "object", properties: {} };

        tools.push({
          name,
          description,
          parameters,
          invoke: async (args: Record<string, any>) => {
            const result = await server.client.callTool({ name, arguments: args ?? {} });
            return stringifyToolResult(result);
          },
        });
      }
    }

    return tools;
  }

  async close(): Promise<void> {
    for (const pending of this.servers.values()) {
      try {
        const s = await pending;
        await s.client.close();
      } catch {
        // best-effort teardown
      }
    }
    this.servers.clear();
  }
}

/** Flatten an MCP tool result into a string payload for the model. */
function stringifyToolResult(result: any): string {
  if (result == null) return "";
  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const block of result.content) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      else parts.push(JSON.stringify(block));
    }
    const text = parts.join("\n");
    if (result.isError) return `TOOL_ERROR: ${text}`;
    return text;
  }
  return JSON.stringify(result);
}
