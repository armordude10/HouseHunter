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

/** How each attached reference image should be used, decided by intent. */
export const ImagePlanSchema = z.object({
  /** 0-based index into the attached image list. */
  index: z.number(),
  role: z.enum([
    /** The image IS the artwork: apply pixel-faithful, no regeneration. */
    "use_verbatim",
    /** Verbatim but with the background removed first. */
    "verbatim_remove_background",
    /** Regenerate guided by this image per `instruction` (cartoonify, change pose not face, add/remove clothing, restyle...). */
    "edit_subject",
    /** Borrow the visual style/palette only. */
    "style_reference",
    /** Incorporate specific element(s) named in `instruction`, not the whole image. */
    "element_reference"
  ]),
  /** What to do with/keep from this image, in plain words. */
  instruction: z.string()
});

export const ExpressIntentSchema = z.object({
  allowed: z.boolean(),
  refusal_reason: z.string().nullable(),
  product_query: z.string(),
  coverage: z.enum(["full", "single"]),
  artwork_brief: z.string(),
  /** Fully-engineered image-generation prompt (the enhancement step). */
  image_prompt: z.string(),
  style_terms: z.array(z.string()),
  palette: z.array(z.string()),
  mood_terms: z.array(z.string()),
  required_text: z.array(z.string()),
  forbidden_text: z.array(z.string()),
  wants_repeat_pattern: z.boolean(),
  /** Customer wants art covering the whole garment (however they phrased it). */
  all_over: z.boolean(),
  /** Stated garment color preference ("black hoodie") or empty string. */
  garment_color: z.string(),
  /** Stated size preference ("XL") or empty string. */
  size_preference: z.string(),
  /** Per-attached-image handling directives (empty when no images). */
  image_plan: z.array(ImagePlanSchema)
});

export type ExpressIntent = z.infer<typeof ExpressIntentSchema>;
export type ImagePlanEntry = z.infer<typeof ImagePlanSchema>;

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

const INTENT_INSTRUCTIONS = `You are Threadbot Express Intent, the single planning step of a print-on-demand design service. You turn ONE messy customer request (plus captions of up to 10 attached reference images) into a production-ready design brief. Customers rarely know garment-production vocabulary — translate what they MEAN, not what they say.
Return JSON with:
- allowed: false ONLY for requests seeking protected trademarks/characters/logos, hate content, sexual content involving minors, or other unprintable material; otherwise true.
- refusal_reason: short customer-safe sentence when allowed=false, else null.
- product_query: the product type they want in plain lowercase words ("hoodie", "t-shirt", "leggings", "mug"). Empty if unstated.
- coverage: "single" ONLY if they explicitly want art on just one area ("just the front"); otherwise "full".
- all_over: true whenever they describe art covering the whole garment IN ANY WORDING ("covered in...", "everywhere", "the entire shirt", "wrapping around", "head to toe") — they will never say "AOP"; that translation is your job.
- artwork_brief: one rich paragraph describing the artwork — subject, composition, mood — faithful to their words and the reference captions.
- image_prompt: a fully-engineered image-generation prompt: subject with concrete visual detail, composition and framing, art style/technique, lighting, color palette, texture and finish quality terms. Faithful to the customer; add professional craft they didn't articulate. NEVER mention garments, panels, seams, mockups, or printing.
- style_terms / palette / mood_terms: short descriptor arrays (may be empty).
- required_text: exact strings they want printed (empty if none). forbidden_text: strings they banned.
- wants_repeat_pattern: true only for repeating/tiled pattern requests.
- garment_color: their stated garment color ("black hoodie" -> "black"), else "".
- size_preference: their stated size ("XL"), else "".
- image_plan: one entry per attached image (by 0-based index) deciding how it is used, from what the TEXT says to do with it:
   * "use_verbatim" — print the image exactly as uploaded, zero changes.
   * "verbatim_remove_background" — exactly as uploaded but background removed.
   * "edit_subject" — regenerate guided by the image with changes in \`instruction\` (make it a cartoon, change the pose but keep the face, add/remove clothing on the subject, restyle it...).
   * "style_reference" — borrow only its style/palette/mood.
   * "element_reference" — incorporate only specific element(s) named in \`instruction\`, not the whole image.
  Default when the text gives no directive: "style_reference" for style-only mentions, else "edit_subject" with instruction "feature this subject faithfully in the design".
  instruction: precise plain-language directive for that image, always non-empty.
Return only JSON.`;

export const heuristicIntent = (text: string): ExpressIntent => ({
  allowed: true,
  refusal_reason: null,
  product_query: "",
  coverage: /\bjust the front\b|\bfront only\b|\bone side\b|\bsingle placement\b/i.test(text)
    ? "single"
    : "full",
  artwork_brief: text.slice(0, 2000),
  image_prompt: text.slice(0, 2000),
  style_terms: [],
  palette: [],
  mood_terms: [],
  required_text: [],
  forbidden_text: [],
  wants_repeat_pattern: /\bpattern\b|\brepeating\b|\btiled\b|\bseamless\b/i.test(text),
  all_over:
    /\ball[- ]?over\b|\beverywhere\b|\bentire (shirt|hoodie|garment)\b|\bcovered (in|with)\b|\bwrap(ping|s)? around\b/i.test(
      text
    ),
  garment_color: "",
  size_preference: "",
  image_plan: []
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
