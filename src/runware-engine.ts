import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getRunwareConfig } from "./runware-client.js";
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

const MAX_ITERATIONS = 16;
const MAX_REPAIRS = 3;

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

  let repairsLeft = MAX_REPAIRS;
  let lastError = "no response";

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
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

    // No tool calls — this should be the final structured answer.
    const text = response.text ?? "";
    const validated = validate(agent, text);
    if (validated.ok) {
      return { output_text: JSON.stringify(validated.data), output_parsed: validated.data };
    }

    // Repair loop: hand the exact validation problems back to the model.
    lastError = validated.error;
    if (repairsLeft > 0) {
      repairsLeft--;
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content:
          `Your previous response did not satisfy the required JSON schema: ${validated.error}. ` +
          `Return the COMPLETE corrected JSON object with ALL required fields present and correctly typed. ` +
          `Output JSON only — no markdown, no commentary.`,
      });
      continue;
    }
    break;
  }

  throw new Error(`${agent.name}: could not produce schema-valid output. Last error: ${lastError}`);
}

// -----------------------------------------------------------------------------
// Runware SDK boundary.
// -----------------------------------------------------------------------------
async function invokeTextInference<T extends z.ZodTypeAny>(
  agent: AgentDef<T>,
  messages: ChatMessage[],
  tools: AgentTool[]
): Promise<NormalizedResponse> {
  const { apiKey, base } = getRunwareConfig();

  // Inline all $refs/definitions — Runware's structured-output validator
  // rejects `$ref`/`definitions`, and reused sub-schemas (e.g. PlacementJob)
  // must be expanded in place.
  const jsonSchema = zodToJsonSchema(agent.schema, {
    $refStrategy: "none",
    target: "openApi3",
  });
  if (jsonSchema && typeof jsonSchema === "object") {
    delete (jsonSchema as any).$schema;
    delete (jsonSchema as any).definitions;
  }

  // Provider-uniform structured output: rather than `response_format` (OpenAI
  // wants json_object, Anthropic demands a schema param, Google rejects
  // json_schema), we hand the schema to the model as a system contract and
  // enforce correctness with Zod + the repair loop in runAgent.
  const contract: ChatMessage = {
    role: "system",
    content:
      `Return a single JSON object that strictly conforms to this JSON Schema. ` +
      `Output JSON only — no markdown, no code fences, no commentary:\n${JSON.stringify(jsonSchema)}`,
  };
  const outMessages = [messages[0], contract, ...messages.slice(1)].map(serializeMessage);

  const request: Record<string, any> = {
    model: agent.model,
    messages: outMessages,
    // GPT-5.x models on Runware require `max_completion_tokens` (not
    // `max_tokens`); it is accepted across the other providers too.
    max_completion_tokens: agent.maxTokens ?? 8000,
    ...(agent.temperature != null ? { temperature: agent.temperature } : {}),
  };

  if (tools.length > 0) {
    request.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    request.tool_choice = "auto";
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`${agent.name}: Runware textInference failed: ${msg}`);
  }
  return normalizeResponse(json);
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
type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

function validate<T extends z.ZodTypeAny>(
  agent: AgentDef<T>,
  text: string
): ValidationResult<z.infer<T>> {
  const json = extractJson(text);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `output was not valid JSON (${(err as Error).message})` };
  }
  const result = agent.schema.safeParse(obj);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, data: result.data };
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
