/**
 * Runware.ai API client.
 *
 * Two transports are used, both documented at https://runware.ai/docs:
 *
 * 1. The native task API (POST https://api.runware.ai/v1) which accepts an
 *    array of task objects. Each task carries `taskType` + `taskUUID` and the
 *    modality-specific parameters. Used for:
 *      - textInference   (LLM calls with strict `jsonSchema` structured outputs)
 *      - imageInference  (FLUX.2 / Recraft / VTO generation and editing)
 *      - removeBackground (BiRefNet transparent PNG output)
 *      - imageUpscale, promptEnhance, modelSearch
 *
 * 2. The OpenAI-compatible chat completions endpoint
 *    (POST https://api.runware.ai/v1/chat/completions) which supports the
 *    standard `tools` / `tool_calls` / role:"tool" round trip. Used for the
 *    agentic MCP tool loop.
 *
 * All generated media is returned as hosted public URLs (im.runware.ai),
 * retained 7 days by default; pass `ttl` to extend retention.
 */

import { randomUUID } from "node:crypto";

const RUNWARE_BASE_URL = process.env.RUNWARE_BASE_URL ?? "https://api.runware.ai/v1";

export interface RunwareTask {
  taskType: string;
  taskUUID?: string;
  [key: string]: unknown;
}

export interface RunwareTaskResult {
  taskType: string;
  taskUUID: string;
  [key: string]: unknown;
}

export interface TextInferenceParams {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  settings?: {
    systemPrompt?: string;
    maxTokens?: number;
    thinkingLevel?: "low" | "medium" | "high";
  };
  jsonSchema?: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
}

export interface TextInferenceResult extends RunwareTaskResult {
  text: string;
  finishReason?: string;
  reasoningContent?: unknown[];
  cost?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  max_tokens?: number;
  stream?: false;
}

export interface ChatCompletionResult {
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: Record<string, number>;
}

export class RunwareError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "RunwareError";
  }
}

export class RunwareClient {
  private readonly apiKey: string;

  constructor(apiKey = process.env.RUNWARE_API_KEY) {
    if (!apiKey) {
      throw new RunwareError(
        "RUNWARE_API_KEY is not set. Create an API key at https://my.runware.ai and export it."
      );
    }
    this.apiKey = apiKey;
  }

  /**
   * Run one or more tasks against the native Runware task API.
   * Transient failures (HTTP 5xx, network errors) are retried with backoff.
   */
  async runTasks(tasks: RunwareTask[]): Promise<RunwareTaskResult[]> {
    const payload = tasks.map((task) => ({
      taskUUID: randomUUID(),
      ...task
    }));
    type TaskResponseBody =
      | { data?: RunwareTaskResult[]; errors?: unknown[] }
      | RunwareTaskResult[]
      | null;
    let response: Response | null = null;
    let body: TaskResponseBody = null;
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        response = await fetch(RUNWARE_BASE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload)
        });
        body = (await response.json().catch(() => null)) as TaskResponseBody;
        if (response.status < 500) break;
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          throw new RunwareError(`Runware task API network failure: ${(error as Error).message}`);
        }
        response = null;
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
      }
    }
    if (!response) {
      throw new RunwareError("Runware task API unreachable after retries");
    }
    if (!response.ok) {
      throw new RunwareError(
        `Runware task API returned HTTP ${response.status}: ${JSON.stringify(body)?.slice(0, 400)}`,
        body
      );
    }
    if (body && !Array.isArray(body) && body.errors?.length) {
      throw new RunwareError(
        `Runware task API returned errors: ${JSON.stringify(body.errors)?.slice(0, 400)}`,
        body.errors
      );
    }
    const data = Array.isArray(body) ? body : (body?.data ?? []);
    if (!data.length) {
      throw new RunwareError("Runware task API returned no task results", body);
    }
    return data;
  }

  /** Single-task convenience wrapper. */
  async runTask<T extends RunwareTaskResult>(task: RunwareTask): Promise<T> {
    const [result] = await this.runTasks([task]);
    return result as T;
  }

  /** Native textInference with optional strict structured output. */
  async textInference(params: TextInferenceParams): Promise<TextInferenceResult> {
    return this.runTask<TextInferenceResult>({
      taskType: "textInference",
      model: params.model,
      settings: params.settings,
      messages: params.messages,
      ...(params.jsonSchema ? { jsonSchema: params.jsonSchema } : {})
    });
  }

  /** OpenAI-compatible chat completions (supports tool calling). */
  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const response = await fetch(`${RUNWARE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ ...params, stream: false })
    });
    const body = (await response.json().catch(() => null)) as ChatCompletionResult | null;
    if (!response.ok || !body) {
      throw new RunwareError(
        `Runware chat completions returned HTTP ${response.status}`,
        body ?? undefined
      );
    }
    return body;
  }
}

export const sharedClient = () => {
  if (!globalThis.__runwareClient) {
    globalThis.__runwareClient = new RunwareClient();
  }
  return globalThis.__runwareClient as RunwareClient;
};

declare global {
  // eslint-disable-next-line no-var
  var __runwareClient: RunwareClient | undefined;
}
