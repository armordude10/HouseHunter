import { Runware } from "@runware/sdk-js";

/**
 * Single shared Runware client. Every LLM `textInference` call and every
 * `imageInference` artwork call in this backend goes through this one client,
 * authenticated with RUNWARE_API_KEY.
 */
type RunwareInstance = InstanceType<typeof Runware>;

let client: RunwareInstance | undefined;

export function getRunware(): RunwareInstance {
  if (client) return client;

  const apiKey = process.env.RUNWARE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RUNWARE_API_KEY is not set. Provide a Runware API key (https://my.runware.ai/keys)."
    );
  }

  client = new Runware({
    apiKey,
    // The SDK constructor accepts `url` for a custom endpoint; omit for default.
    ...(process.env.RUNWARE_BASE_URL ? { url: process.env.RUNWARE_BASE_URL } : {}),
  });

  return client;
}
