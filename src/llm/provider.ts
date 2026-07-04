/**
 * LLM provider abstraction for the agent runtime.
 *
 * Two providers, selected by LLM_PROVIDER (or inferred from available keys):
 *  - "runware": OpenAI-compatible chat completions for the tool loop and
 *    native textInference with strict jsonSchema for structured outputs.
 *  - "openai": chat completions for both — tools via the standard round
 *    trip, structured outputs via response_format json_schema. Used when
 *    Runware credits are unavailable; the per-node model registry maps to
 *    gpt-5.5 / gpt-5.5-mini.
 *
 * The Placement Bundle artwork generation is independent of this choice:
 * with THREADBOT_ARTWORK_MCP_URL set, artwork runs on the hosted
 * threadbot-artwork-mcp (OpenAI gpt-image-1.5).
 */

import {
  ChatCompletionParams,
  ChatCompletionResult,
  RunwareClient,
  sharedClient
} from "../runware/client.js";

export type LlmProviderName = "runware" | "openai";

/** Cumulative token usage for cost visibility (reported per run by the server). */
export const usageTally = { calls: 0, input_tokens: 0, output_tokens: 0 };

export interface StructuredParams {
  model: string;
  systemPrompt: string;
  userText: string;
  jsonSchema: { name: string; strict: boolean; schema: Record<string, unknown> };
  maxTokens: number;
  thinkingLevel: "low" | "medium" | "high";
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  /** Resolve a node's registry model (Runware AIR id) to this provider. */
  resolveModel(runwareModel: string, thinkingLevel: string): string;
  chat(params: ChatCompletionParams): Promise<ChatCompletionResult>;
  structured(params: StructuredParams): Promise<string>;
  captionImage(url: string): Promise<string>;
}

export const activeProviderName = (): LlmProviderName => {
  const explicit = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (explicit === "openai" || explicit === "runware") return explicit;
  if (process.env.OPENAI_API_KEY && !process.env.RUNWARE_API_KEY) return "openai";
  return "runware";
};

// -----------------------------------------------------------------------------
// Runware provider (existing behavior).
// -----------------------------------------------------------------------------

class RunwareProvider implements LlmProvider {
  readonly name = "runware" as const;
  constructor(private readonly client: RunwareClient = sharedClient()) {}

  resolveModel(runwareModel: string): string {
    return runwareModel;
  }

  chat(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    return this.client.chatCompletion(params);
  }

  async structured(params: StructuredParams): Promise<string> {
    const result = await this.client.textInference({
      model: params.model,
      settings: {
        systemPrompt: params.systemPrompt,
        maxTokens: params.maxTokens,
        thinkingLevel: params.thinkingLevel
      },
      messages: [{ role: "user", content: params.userText }],
      jsonSchema: params.jsonSchema
    });
    return result.text;
  }

  async captionImage(url: string): Promise<string> {
    const { RunwareMedia } = await import("../runware/media.js");
    return new RunwareMedia(this.client).imageCaption(url);
  }
}

// -----------------------------------------------------------------------------
// OpenAI provider.
// -----------------------------------------------------------------------------

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

/**
 * Registry (Runware AIR id) -> OpenAI model. Light nodes ride the mini.
 * Overridable per deployment: OPENAI_MODEL_HEAVY / OPENAI_MODEL_LIGHT.
 */
const HEAVY = process.env.OPENAI_MODEL_HEAVY ?? "gpt-5.5";
const LIGHT = process.env.OPENAI_MODEL_LIGHT ?? "gpt-5.4-mini";
const OPENAI_MODEL_MAP: Record<string, string> = {
  "deepseek:v4@flash": LIGHT,
  "minimax:m2.7@0": LIGHT,
  "minimax:m3@0": HEAVY,
  "openai:gpt@5.5": HEAVY,
  "anthropic:claude@opus-4.8": HEAVY
};

class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  private readonly apiKey: string;

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    this.apiKey = apiKey;
  }

  resolveModel(runwareModel: string): string {
    return OPENAI_MODEL_MAP[runwareModel] ?? HEAVY;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
        continue;
      }
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !parsed) {
        throw new Error(
          `OpenAI ${path} HTTP ${response.status}: ${JSON.stringify(parsed)?.slice(0, 300)}`
        );
      }
      const usage = (parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      usageTally.calls += 1;
      usageTally.input_tokens += usage?.prompt_tokens ?? 0;
      usageTally.output_tokens += usage?.completion_tokens ?? 0;
      return parsed;
    }
  }

  async chat(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model: this.resolveModel(params.model),
      messages: params.messages,
      max_completion_tokens: params.max_tokens,
      // Keep reasoning burn low in tool loops; quality lives in the
      // structured finalize call and the Zod gate.
      reasoning_effort: process.env.OPENAI_REASONING_EFFORT ?? "low"
    };
    if (params.tools?.length) {
      body.tools = params.tools;
      body.tool_choice = params.tool_choice ?? "auto";
    }
    return (await this.post("/chat/completions", body)) as ChatCompletionResult;
  }

  async structured(params: StructuredParams): Promise<string> {
    const base = {
      model: this.resolveModel(params.model),
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userText }
      ],
      max_completion_tokens: params.maxTokens,
      reasoning_effort: params.thinkingLevel === "high" ? "medium" : "low"
    };
    // Strict mode rejects open-ended subschemas (z.any() -> {}); degrade
    // gracefully: strict -> non-strict -> json_object mode. Zod validation
    // downstream remains the real gate.
    const formats: Array<Record<string, unknown>> = [
      {
        type: "json_schema",
        json_schema: {
          name: params.jsonSchema.name,
          strict: true,
          schema: params.jsonSchema.schema
        }
      },
      {
        type: "json_schema",
        json_schema: {
          name: params.jsonSchema.name,
          strict: false,
          schema: params.jsonSchema.schema
        }
      },
      { type: "json_object" }
    ];
    let lastError: Error | null = null;
    for (const response_format of formats) {
      try {
        const result = (await this.post("/chat/completions", {
          ...base,
          response_format
        })) as ChatCompletionResult;
        return result.choices?.[0]?.message?.content ?? "";
      } catch (error) {
        lastError = error as Error;
        if (!/schema|response_format|invalid/i.test(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error("structured output failed");
  }

  async captionImage(url: string): Promise<string> {
    const result = (await this.post("/chat/completions", {
      model: LIGHT,
      max_completion_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe this image in 1-2 compact sentences for a garment designer: subject, style, palette."
            },
            { type: "image_url", image_url: { url } }
          ]
        }
      ]
    })) as ChatCompletionResult;
    return result.choices?.[0]?.message?.content ?? "";
  }
}

let cached: LlmProvider | null = null;
export const getLlmProvider = (): LlmProvider => {
  if (!cached) {
    cached = activeProviderName() === "openai" ? new OpenAIProvider() : new RunwareProvider();
  }
  return cached;
};
