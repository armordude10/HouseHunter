/**
 * Runware REST configuration.
 *
 * We talk to Runware over its HTTPS REST surface rather than the SDK's
 * WebSocket transport:
 *   - LLM inference  → OpenAI-compatible `POST {base}/chat/completions`
 *   - image inference → native tasks `POST {base}` (array of task objects)
 *
 * REST is used because it is verifiable in every environment (some sandboxes /
 * egress proxies block outbound WebSockets) and behaves identically on Cloud
 * Run. It is still 100% Runware: same endpoint, same models, same API key.
 */
export interface RunwareConfig {
  apiKey: string;
  /** e.g. https://api.runware.ai/v1 */
  base: string;
}

export function getRunwareConfig(): RunwareConfig {
  const apiKey = process.env.RUNWARE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RUNWARE_API_KEY is not set. Provide a Runware API key (https://my.runware.ai/keys)."
    );
  }
  const base = (process.env.RUNWARE_BASE_URL || "https://api.runware.ai/v1").replace(/\/+$/, "");
  return { apiKey, base };
}
