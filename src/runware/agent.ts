/**
 * Minimal agent runtime on top of Runware.ai, replacing the former
 * @openai/agents dependency (Agent, Runner, hostedMcpTool, withTrace).
 *
 * Execution model per agent run:
 *
 *  1. If the agent has tools, an agentic loop runs against Runware's
 *     OpenAI-compatible chat completions endpoint, which supports the
 *     standard tools / tool_calls / role:"tool" round trip. MCP tools are
 *     executed client-side via @modelcontextprotocol/sdk (streamable HTTP),
 *     mirroring what hostedMcpTool did server-side. Local (in-process) tools
 *     are executed directly.
 *
 *  2. The final structured output is produced with Runware's native
 *     textInference task using a strict jsonSchema derived from the agent's
 *     Zod outputType, then validated with Zod. One repair retry is attempted
 *     on validation failure.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChatMessage, ChatToolDefinition } from "./client.js";
import { NODE_MODELS } from "./models.js";
import { getLlmProvider, LlmProvider } from "../llm/provider.js";

const MAX_TOOL_TURNS = 14;
/** Output budget for tool-loop turns (tool calls + short reasoning). */
const LOOP_OUTPUT_TOKENS = 4000;
/** Output budget for the final structured JSON (large plan payloads). */
const MAX_OUTPUT_TOKENS = 16000;

// -----------------------------------------------------------------------------
// Toolsets.
// -----------------------------------------------------------------------------

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface Toolset {
  label: string;
  tools: () => Promise<AgentTool[]>;
  close?: () => Promise<void>;
}

export interface McpToolsetConfig {
  serverLabel: string;
  serverUrl: string;
  allowedTools: string[];
  requireApproval?: "never";
}

/**
 * Drop-in replacement for hostedMcpTool: connects to the MCP server over
 * streamable HTTP, exposes only the allowlisted tools, and executes tool
 * calls client-side. Connections are lazy and cached per server URL.
 */
export const mcpToolset = (config: McpToolsetConfig): Toolset => {
  let clientPromise: Promise<McpClient> | null = null;

  const connect = () => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const client = new McpClient({
          name: `threadbot-runware/${config.serverLabel}`,
          version: "1.0.0"
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(config.serverUrl))
        );
        return client;
      })();
    }
    return clientPromise;
  };

  return {
    label: config.serverLabel,
    tools: async () => {
      const client = await connect();
      const listed = await client.listTools();
      return listed.tools
        .filter((tool) => config.allowedTools.includes(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: (tool.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {}
          },
          execute: async (args) => {
            const result = await client.callTool({ name: tool.name, arguments: args });
            return typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content);
          }
        }));
    },
    close: async () => {
      if (clientPromise) {
        const client = await clientPromise;
        await client.close();
        clientPromise = null;
      }
    }
  };
};

/** In-process toolset (used for the Runware-backed artwork tools). */
export const localToolset = (label: string, tools: AgentTool[]): Toolset => ({
  label,
  tools: async () => tools
});

// -----------------------------------------------------------------------------
// Agent + Runner.
// -----------------------------------------------------------------------------

export interface AgentConfig<TSchema extends z.ZodTypeAny> {
  name: string;
  instructions: string;
  outputType: TSchema;
  tools?: Toolset[];
  /** Optional override; defaults to the per-node registry in models.ts. */
  model?: string;
  thinkingLevel?: "low" | "medium" | "high";
}

export class Agent<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly instructions: string;
  readonly outputType: TSchema;
  readonly tools: Toolset[];
  readonly model: string;
  readonly thinkingLevel: "low" | "medium" | "high";

  constructor(config: AgentConfig<TSchema>) {
    this.name = config.name;
    this.instructions = config.instructions;
    this.outputType = config.outputType;
    this.tools = config.tools ?? [];
    const registered = NODE_MODELS[config.name];
    this.model = config.model ?? registered?.model ?? "openai:gpt@5.5";
    this.thinkingLevel = config.thinkingLevel ?? registered?.thinkingLevel ?? "medium";
  }
}

export interface RunResult<TSchema extends z.ZodTypeAny> {
  finalOutput: z.infer<TSchema> | undefined;
}

const schemaName = (agentName: string) =>
  agentName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * Cap one transcript part so a single enormous tool result (a full surface
 * graph, a catalog dump) cannot blow out the structured-output call's
 * context. Head and tail are kept — truth gates and summaries usually live
 * at the edges of tool payloads.
 */
export const capText = (text: string, max = 20000): string => {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n...[${text.length - max} chars truncated]...\n${text.slice(-half)}`;
};

const extractJson = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
};

/**
 * Hard per-run LLM call budget for the agent pipeline. A single workflow run
 * shares one Runner; if node loops ever spiral, the run fails loudly at a
 * bounded cost instead of burning an invoice. Tune per deployment.
 */
const LLM_CALL_BUDGET = Number(process.env.THREADBOT_LLM_CALL_BUDGET ?? 200);

export class Runner {
  private llmCalls = 0;

  constructor(private readonly provider: LlmProvider = getLlmProvider()) {}

  private spend(kind: string) {
    this.llmCalls += 1;
    if (this.llmCalls > LLM_CALL_BUDGET) {
      throw new Error(
        `LLM call budget exhausted (${LLM_CALL_BUDGET} calls) at ${kind}; ` +
          `aborting run to cap spend. Raise THREADBOT_LLM_CALL_BUDGET if intentional.`
      );
    }
  }

  async run<TSchema extends z.ZodTypeAny>(
    agent: Agent<TSchema>,
    userInput: string
  ): Promise<RunResult<TSchema>> {
    const transcript: ChatMessage[] = [
      { role: "system", content: agent.instructions },
      { role: "user", content: userInput }
    ];

    if (agent.tools.length > 0) {
      await this.runToolLoop(agent, transcript);
    }

    const finalOutput = await this.finalizeStructuredOutput(agent, transcript);
    return { finalOutput };
  }

  /** Agentic loop over Runware's OpenAI-compatible endpoint. */
  private async runToolLoop(agent: Agent<z.ZodTypeAny>, transcript: ChatMessage[]) {
    const toolIndex = new Map<string, AgentTool>();
    const definitions: ChatToolDefinition[] = [];
    for (const toolset of agent.tools) {
      for (const tool of await toolset.tools()) {
        if (!toolIndex.has(tool.name)) {
          toolIndex.set(tool.name, tool);
          definitions.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters
            }
          });
        }
      }
    }
    if (!definitions.length) return;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      this.spend(`${agent.name} tool loop turn ${turn + 1}`);
      const completion = await this.provider.chat({
        model: agent.model,
        messages: transcript,
        tools: definitions,
        tool_choice: "auto",
        max_tokens: LOOP_OUTPUT_TOKENS
      });
      const message = completion.choices[0]?.message;
      if (!message) break;
      transcript.push(message);
      if (!message.tool_calls?.length) break;

      for (const call of message.tool_calls) {
        const tool = toolIndex.get(call.function.name);
        let content: string;
        if (!tool) {
          content = JSON.stringify({ error: `Unknown tool: ${call.function.name}` });
        } else {
          try {
            const args = call.function.arguments
              ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
              : {};
            content = await tool.execute(args);
          } catch (error) {
            content = JSON.stringify({
              error: `Tool execution failed: ${(error as Error).message}`
            });
          }
        }
        // COST CONTROL: tool payloads (surface graphs, geometry) can be
        // 100KB+; uncapped they re-bill as input on EVERY subsequent turn.
        transcript.push({ role: "tool", tool_call_id: call.id, content: capText(content, 16000) });
      }
    }
  }

  /** Strict structured output via native textInference + jsonSchema. */
  private async finalizeStructuredOutput<TSchema extends z.ZodTypeAny>(
    agent: Agent<TSchema>,
    transcript: ChatMessage[]
  ): Promise<z.infer<TSchema> | undefined> {
    const jsonSchema = zodToJsonSchema(agent.outputType, {
      target: "openAi",
      $refStrategy: "none"
    }) as Record<string, unknown>;

    // textInference messages are plain text; fold tool activity into a
    // readable transcript so nothing established during the loop is lost.
    const folded = transcript
      .slice(1)
      .map((message) => {
        if (message.role === "tool") {
          return `TOOL RESULT (${message.tool_call_id ?? "unknown"}):\n${capText(message.content ?? "")}`;
        }
        if (message.role === "assistant" && message.tool_calls?.length) {
          const calls = message.tool_calls
            .map((call) => `${call.function.name}(${capText(call.function.arguments, 4000)})`)
            .join("\n");
          return `ASSISTANT TOOL CALLS:\n${calls}${message.content ? `\n${capText(message.content)}` : ""}`;
        }
        return `${message.role.toUpperCase()}:\n${capText(message.content ?? "")}`;
      })
      .join("\n\n");

    let repairNote = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      this.spend(`${agent.name} structured finalize`);
      const text = await this.provider.structured({
        model: agent.model,
        systemPrompt: agent.instructions,
        userText: `${folded}\n\nReturn only JSON matching the configured schema.${repairNote}`,
        jsonSchema: {
          name: schemaName(agent.name),
          strict: true,
          schema: jsonSchema
        },
        maxTokens: MAX_OUTPUT_TOKENS,
        thinkingLevel: agent.thinkingLevel
      });

      try {
        const parsed = JSON.parse(extractJson(text));
        return agent.outputType.parse(parsed);
      } catch (error) {
        repairNote = `\n\nYour previous output failed schema validation: ${
          (error as Error).message
        }. Return corrected JSON only.`;
      }
    }
    return undefined;
  }
}

/** Lightweight tracing wrapper replacing @openai/agents withTrace. */
export const withTrace = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const startedAt = Date.now();
  console.error(`[trace] ${name} started`);
  try {
    const result = await fn();
    console.error(`[trace] ${name} finished in ${Date.now() - startedAt}ms`);
    return result;
  } catch (error) {
    console.error(`[trace] ${name} failed after ${Date.now() - startedAt}ms`, error);
    throw error;
  }
};
