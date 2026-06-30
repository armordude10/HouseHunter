import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getRunware } from "./runware-client.js";
import type { AgentTool } from "./tools.js";

/**
 * RUNWARE INFERENCE ENGINE
 *
 * This is the hand-rolled replacement for the OpenAI-Agents `Runner`. Each
 * agent node runs through `runAgent`, which:
 *
 *   1. Issues a Runware native `textInference` request with the agent's
 *      instructions as the system prompt, the agent's best-fit Runware model,
 *      the reasoning-effort setting, the advertised tools, and a strict
 *      JSON-Schema structured-output contract derived from the agent's Zod
 *      schema (instructions and schemas are unchanged from the original).
 *   2. Runs a local tool-call loop: if the model asks to call a tool, we
 *      dispatch it to the matching AgentTool (a client-side Threadbot MCP tool
 *      or the Runware-backed artwork tool), append the result, and re-invoke.
 *   3. Validates the model's final JSON answer against the Zod schema and
 *      returns the typed result.
 *
 * The single point that touches the Runware SDK's exact field names is
 * `invokeTextInference` + `normalizeResponse`, so any SDK shape adjustment is a
 * one-place change.
 */

export interface AgentDef<T extends z.ZodTypeAny> {
  name: string;
  /** Runware AIR model identifier, e.g. "anthropic:claude@opus-4.8". */
  model: string;
  /** System instructions — ported VERBATIM from the original workflow. */
  instructions: string;
  reasoningEffort?: "low" | "medium" | "high";
  reasoningSummary?: "auto";
  schema: T;
  /** Stable name for the structured-output schema envelope. */
  schemaName: string;
  tools?: AgentTool[];
  maxTokens?: number;
  temperature?: number;
}

export interface AgentResult<T> {
  output_text: string;
  output_parsed: T;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: NormalizedToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface NormalizedResponse {
  text: string | null;
  toolCalls: NormalizedToolCall[];
}

const MAX_TOOL_ITERATIONS = 12;

export async function runAgent<T extends z.ZodTypeAny>(
  agent: AgentDef<T>,
  userText: string
): Promise<AgentResult<z.infer<T>>> {
  const tools = agent.tools ?? [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const messages: ChatMessage[] = [
    { role: "system", content: agent.instructions },
    { role: "user", content: userText },
  ];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await invokeTextInference(agent, messages, tools);

    if (response.toolCalls.length > 0) {
      // Record the assistant's tool-call turn.
      messages.push({ role: "assistant", content: response.text, tool_calls: response.toolCalls });

      // Execute every requested tool and feed results back.
      for (const call of response.toolCalls) {
        const tool = toolsByName.get(call.name);
        let result: string;
        if (!tool) {
          result = `TOOL_ERROR: unknown tool "${call.name}". Allowed tools: ${tools
            .map((t) => t.name)
            .join(", ")}`;
        } else {
          try {
            result = await tool.invoke(call.arguments);
          } catch (err) {
            result = `TOOL_ERROR: ${(err as Error).message}`;
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: result,
        });
      }
      continue;
    }

    // No tool calls — this is the final structured answer.
    const text = response.text ?? "";
    const parsed = parseAndValidate(agent, text);
    return { output_text: JSON.stringify(parsed), output_parsed: parsed };
  }

  throw new Error(
    `${agent.name}: exceeded ${MAX_TOOL_ITERATIONS} tool iterations without producing a final answer`
  );
}

// -----------------------------------------------------------------------------
// Runware SDK boundary.
// -----------------------------------------------------------------------------
async function invokeTextInference<T extends z.ZodTypeAny>(
  agent: AgentDef<T>,
  messages: ChatMessage[],
  tools: AgentTool[]
): Promise<NormalizedResponse> {
  const runware = getRunware();

  const jsonSchema = zodToJsonSchema(agent.schema, {
    name: agent.schemaName,
    target: "openApi3",
  });

  // The system turn (agent instructions) is carried in the dedicated
  // `systemPrompt` field; remaining turns go in `messages`. This matches the
  // native @runware/sdk-js IRequestTextInference shape (flat params, not a
  // `settings` wrapper). Tool/structured-output fields ride the request's
  // index signature.
  const systemPrompt = messages.find((m) => m.role === "system")?.content ?? agent.instructions;
  const convo = messages.filter((m) => m.role !== "system").map(serializeMessage);

  const request: Record<string, any> = {
    taskType: "textInference",
    model: agent.model,
    systemPrompt,
    messages: convo,
    maxTokens: agent.maxTokens ?? 8000,
    ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
    // JSON structured output. Runware honors `schema` when outputFormat is JSON
    // and accepts the OpenAI envelope {name, schema, strict}. We keep strict
    // off (some node schemas use open `any`/optional fields) and re-validate
    // the result against the unchanged Zod schema ourselves.
    outputFormat: "json",
    schema: {
      name: agent.schemaName,
      strict: false,
      schema: jsonSchema,
    },
    includeCost: true,
  };

  if (agent.reasoningEffort) {
    request.reasoningEffort = agent.reasoningEffort;
    if (agent.reasoningSummary) request.reasoningSummary = agent.reasoningSummary;
  }

  if (tools.length > 0) {
    request.tools = tools.map((t) => ({
      toolType: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    request.toolChoice = "auto";
  }

  // `textInference` is the native LLM task method on @runware/sdk-js (added in
  // v1.2.5). It is cast here because tool-calling fields are passed through the
  // request's index signature and tool calls are read from the (untyped)
  // response; we normalize whatever shape comes back.
  const raw = await (runware as { textInference: (p: any) => Promise<any> }).textInference(request);
  return normalizeResponse(Array.isArray(raw) ? raw[0] : raw);
}

function serializeMessage(m: ChatMessage): Record<string, any> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.tool_call_id,
      name: m.name,
      content: m.content ?? "",
    };
  }
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content ?? "" };
}

/**
 * Normalize the Runware textInference response. Tolerates both a native
 * `{ text, toolCalls }` shape and the OpenAI-compatible `{ choices: [...] }`
 * shape so the engine is resilient to SDK/transport differences.
 */
function normalizeResponse(raw: any): NormalizedResponse {
  if (!raw) return { text: "", toolCalls: [] };

  // Native shape: { text, toolCalls?: [...] }
  if (typeof raw.text === "string" || Array.isArray(raw.toolCalls)) {
    return {
      text: typeof raw.text === "string" ? raw.text : null,
      toolCalls: normalizeToolCalls(raw.toolCalls),
    };
  }

  // Some SDK builds wrap the task result in `data[0]`.
  const candidate = Array.isArray(raw.data) ? raw.data[0] : raw;
  if (candidate && (typeof candidate.text === "string" || Array.isArray(candidate.toolCalls))) {
    return {
      text: typeof candidate.text === "string" ? candidate.text : null,
      toolCalls: normalizeToolCalls(candidate.toolCalls),
    };
  }

  // OpenAI-compatible shape: { choices: [{ message: { content, tool_calls } }] }
  const message = candidate?.choices?.[0]?.message;
  if (message) {
    return {
      text: typeof message.content === "string" ? message.content : null,
      toolCalls: normalizeToolCalls(message.tool_calls),
    };
  }

  return { text: "", toolCalls: [] };
}

function normalizeToolCalls(calls: any): NormalizedToolCall[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((c, i) => {
    const fn = c.function ?? c;
    const name: string = fn.name ?? c.name ?? `tool_${i}`;
    const rawArgs = fn.arguments ?? c.arguments ?? {};
    let args: Record<string, any> = {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs;
    }
    return { id: c.id ?? `call_${i}`, name, arguments: args };
  });
}

// -----------------------------------------------------------------------------
// Output validation.
// -----------------------------------------------------------------------------
function parseAndValidate<T extends z.ZodTypeAny>(agent: AgentDef<T>, text: string): z.infer<T> {
  const json = extractJson(text);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new Error(`${agent.name}: model output was not valid JSON: ${(err as Error).message}`);
  }
  const result = agent.schema.safeParse(obj);
  if (!result.success) {
    throw new Error(
      `${agent.name}: output failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  }
  return result.data;
}

/** Strip optional markdown code fences and isolate the JSON object. */
function extractJson(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return t.slice(first, last + 1);
  }
  return t;
}
