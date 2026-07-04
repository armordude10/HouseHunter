/**
 * Express-path intent: the ONE paid LLM judgment per run.
 *
 * A single structured call on the light model turns the raw customer text
 * (plus reference-image captions) into a design brief, coverage choice and a
 * policy verdict. Everything downstream is deterministic code.
 *
 * Layers, cheapest first:
 *   1. Deterministic blocklist (regex, $0) — obvious protected-IP and abuse
 *      terms refuse the run before ANY token is spent.
 *   2. One structured light-model call — brief + policy flags (policy is
 *      folded into the same call; a separate policy call would double the
 *      LLM cost for no accuracy gain at this tier).
 *   3. Heuristic fallback — if the model call fails, the run proceeds with
 *      the raw text as the brief rather than dying: an express run must
 *      never be lost to a provider hiccup.
 *
 * These instructions are EXPRESS-ONLY. The 13 frozen agent instructions in
 * src/instructions.ts are untouched; the agent pipeline remains available as
 * the premium/fallback mode.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LlmProvider } from "../llm/provider.js";
import { LLM } from "../runware/models.js";

export const ExpressIntentSchema = z.object({
  allowed: z.boolean(),
  refusal_reason: z.string().nullable(),
  product_query: z.string(),
  coverage: z.enum(["full", "single"]),
  artwork_brief: z.string(),
  style_terms: z.array(z.string()),
  palette: z.array(z.string()),
  mood_terms: z.array(z.string()),
  required_text: z.array(z.string()),
  forbidden_text: z.array(z.string()),
  wants_repeat_pattern: z.boolean()
});

export type ExpressIntent = z.infer<typeof ExpressIntentSchema>;

/**
 * $0 pre-gate for unambiguous protected marks and abuse content. This is a
 * coarse first filter — the intent call also returns `allowed` for anything
 * subtler. False negatives fall through to the model; false positives are
 * kept rare by matching whole words of famous marks only.
 */
const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
  [/\bnike\b|\bswoosh\b/i, "Nike branding"],
  [/\badidas\b/i, "Adidas branding"],
  [/\bsupreme\s+logo\b|\bsupreme\s+box\s+logo\b/i, "Supreme branding"],
  [/\bgucci\b|\blouis\s*vuitton\b|\bchanel\b/i, "luxury-brand marks"],
  [/\bdisney\b|\bmickey\s+mouse\b|\bpixar\b/i, "Disney IP"],
  [/\bmarvel\b|\bspider[- ]?man\b|\bavengers\b/i, "Marvel IP"],
  [/\bstar\s+wars\b|\bdarth\s+vader\b/i, "Star Wars IP"],
  [/\bpokemon\b|\bpikachu\b/i, "Pokémon IP"],
  [/\bnintendo\b|\bsuper\s+mario\b|\bzelda\b/i, "Nintendo IP"],
  [/\bhello\s+kitty\b/i, "Sanrio IP"],
  [/\bharry\s+potter\b|\bhogwarts\b/i, "Harry Potter IP"],
  [/\bcoca[- ]?cola\b/i, "Coca-Cola branding"],
  [/\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b/i, "sports-league marks"],
  [/\bswastika\b|\b1488\b|\bss\s+bolts\b/i, "hate symbolism"]
];

export const screenRequest = (text: string): { blocked: boolean; reason: string } => {
  for (const [pattern, label] of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return {
        blocked: true,
        reason: `The request references ${label}, which Threadbot cannot print. Please describe an original design instead.`
      };
    }
  }
  return { blocked: false, reason: "" };
};

const INTENT_INSTRUCTIONS = `You are Threadbot Express Intent, the single planning step of a print-on-demand design service.
Given one raw customer request (and optional captions of attached reference images), return JSON with:
- allowed: false ONLY for requests seeking protected trademarks/characters/logos, hate content, sexual content involving minors, or other unprintable material; otherwise true.
- refusal_reason: short customer-safe sentence when allowed=false, else null.
- product_query: the product type the customer wants, in a few plain lowercase words (e.g. "hoodie", "t-shirt", "leggings", "mug"). Empty string if unstated.
- coverage: "single" ONLY if the customer explicitly wants art on just one area (e.g. "just the front"); otherwise "full".
- artwork_brief: one rich paragraph describing the artwork to generate — subject, composition, mood. Faithful to the customer's words and any reference-image captions. Never mention garments, panels, seams, or printing.
- style_terms / palette / mood_terms: short arrays of descriptors (may be empty).
- required_text: exact strings the customer wants printed (empty if none). forbidden_text: strings they explicitly banned.
- wants_repeat_pattern: true only if they ask for a repeating/tiled pattern.
Return only JSON.`;

export const heuristicIntent = (text: string): ExpressIntent => ({
  allowed: true,
  refusal_reason: null,
  product_query: "",
  coverage: /\bjust the front\b|\bfront only\b|\bone side\b|\bsingle placement\b/i.test(text)
    ? "single"
    : "full",
  artwork_brief: text.slice(0, 2000),
  style_terms: [],
  palette: [],
  mood_terms: [],
  required_text: [],
  forbidden_text: [],
  wants_repeat_pattern: /\bpattern\b|\brepeating\b|\btiled\b|\bseamless\b/i.test(text)
});

export const deriveIntent = async (
  provider: LlmProvider,
  text: string,
  imageCaptions: string[]
): Promise<{ intent: ExpressIntent; degraded: boolean }> => {
  const captionBlock = imageCaptions.length
    ? `\n\nAttached reference image captions:\n${imageCaptions
        .map((caption, i) => `${i + 1}. ${caption}`)
        .join("\n")}`
    : "";
  try {
    const raw = await provider.structured({
      model: LLM.DEEPSEEK_V4_FLASH,
      systemPrompt: INTENT_INSTRUCTIONS,
      userText: `Customer request:\n${text.slice(0, 6000)}${captionBlock}`,
      jsonSchema: {
        name: "express_intent",
        strict: true,
        schema: zodToJsonSchema(ExpressIntentSchema, {
          target: "openAi",
          $refStrategy: "none"
        }) as Record<string, unknown>
      },
      maxTokens: 1200,
      thinkingLevel: "low"
    });
    return { intent: ExpressIntentSchema.parse(JSON.parse(raw)), degraded: false };
  } catch (error) {
    console.error(`[express] intent call failed, using heuristic: ${(error as Error).message}`);
    return { intent: heuristicIntent(text), degraded: true };
  }
};
