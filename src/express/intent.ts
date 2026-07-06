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

/**
 * A grounded design layer: the intent model plans WHAT goes WHERE (an
 * LLM-as-layout-planner, per Ranni arXiv:2311.17002 / RPG arXiv:2401.11708),
 * and the layer engine places it with exact pixel math (box grounding per
 * GLIGEN arXiv:2301.07093, executed as deterministic compositing instead of
 * attention steering). ALL text is GENERATED lettering styled to the design —
 * plain code-rendered fonts are retired; only the lockup's placement is
 * deterministic. Element layers are generated with native alpha
 * (LayerDiffuse-class transparency, arXiv:2402.17113).
 */
export const LayerSchema = z.object({
  kind: z.enum(["text", "element", "customer_image"]),
  /** Text string to set, or the element's generation prompt ("" for customer_image). */
  content: z.string(),
  /** 0-based attached-image index for kind=customer_image, else null. */
  image_index: z.number().nullable(),
  /** Target placement ("front", "back", "sleeve_left"...); "front" default. */
  placement: z.string(),
  /** Layer center within the VISIBLE piece, fractions 0..1 (0.5,0.5 = center of chest). */
  cx_frac: z.number(),
  cy_frac: z.number(),
  /** Layer width as a fraction of the piece width (0..1). */
  width_frac: z.number(),
  rotation_deg: z.number(),
  /** Text color (CSS color) for kind=text; "" for default near-black. */
  color: z.string(),
  /** Composite order; lower renders first (underneath). */
  order: z.number()
});

export type DesignLayer = z.infer<typeof LayerSchema>;

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
  /**
   * Variant-selecting detail beyond color/size: device model ("iphone 15
   * pro max", "samsung s24"), capacity ("15 oz"), dimensions ("18x24"),
   * or any wording that picks WHICH version of the product. Empty if none.
   */
  variant_hint: z.string(),
  /** Per-attached-image handling directives (empty when no images). */
  image_plan: z.array(ImagePlanSchema),
  /**
   * Grounded layer layout — ONLY when the customer asks for specific
   * elements/text at specific positions/scales; empty for whole-artwork
   * requests (those use the master/pattern engines).
   */
  layers: z.array(LayerSchema),
  /**
   * true = the layers ARE the whole design (blank garment beneath);
   * false = the layers composite ON TOP of the full generated artwork.
   */
  layers_only: z.boolean()
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

const INTENT_INSTRUCTIONS = `You are Threadbot Express Intent, the single planning step of a print-on-demand design service. You turn ONE messy customer request (plus captions of up to 10 attached reference images) into a production-ready design brief. Customers rarely know garment-production vocabulary and often typo — translate what they MEAN, not what they say, and silently fix obvious typos ("hoddie" -> hoodie, "leggins" -> leggings).
The input may end with a bracketed "[Platform taste hints ...]" block summarizing this customer's past style leanings. Treat it as SOFT guidance for details the customer left unspecified — it must NEVER override anything they actually asked for, and it is not part of the customer's request text.
Return JSON with:
- allowed: false ONLY for requests seeking protected trademarks/characters/logos, hate content, sexual content involving minors, or other unprintable material; otherwise true.
- refusal_reason: short customer-safe sentence when allowed=false, else null.
- product_query: the product type they want in plain lowercase supplier-neutral words, typos fixed. The catalog spans far beyond shirts — apparel (tees, long sleeves, oversized tees/hoodies, sweatshirts, zip hoodies, polos, tanks, crop tops, dresses, skirts, leggings, shorts, sweatpants/joggers, swimwear/bikinis/trunks/rash guards, jerseys, socks, shoes/slides/flip-flops, jackets/windbreakers/vests, hats/caps/beanies/visors), kids/toddler/baby everything, bags (tote, backpack, fanny pack, duffle, crossbody, drawstring, laptop sleeve, gym), phone/AirPods cases (iPhone, Samsung), home (posters, framed posters, canvas, blankets, pillows, towels, shower curtains, rugs, mats, tapestries, candles, ornaments, mugs, glasses, bottles, tumblers, aprons, coasters), stationery (stickers, cards, notebooks, journals, calendars, magnets, puzzles, playing cards, mouse pads), pet gear (collars, leashes, bowls, bandanas). Name the type they MEAN ("wall art of..." -> "poster" or "canvas"; "onesie" -> "baby bodysuit"). Empty if truly unstated.
- variant_hint: wording that selects WHICH version of the product: device model ("iphone 15 pro max", "samsung galaxy s24"), capacity ("15 oz"), print dimensions ("18x24"), pack counts. Empty if none.
- coverage: "single" ONLY if they explicitly want art on just one area ("just the front"); otherwise "full".
- all_over: true whenever they describe art covering the whole garment IN ANY WORDING ("covered in...", "everywhere", "the entire shirt", "wrapping around", "head to toe"), use the industry terms "AOP"/"all-over print"/"sublimation" (including typo'd forms), OR the concept itself inherently demands continuous full-surface coverage even if they never say so: repeating patterns, tie-dye, camo, galaxy/space wash, gradients, "make it look like it's made of flames/water/fur", full-scene artwork. Translating what the DESIGN needs into this flag is your job.
- artwork_brief: one rich paragraph describing the artwork — subject, composition, mood — faithful to their words and the reference captions.
- image_prompt: a fully-engineered image-generation prompt (when a layer carries text, image_prompt and artwork_brief must NOT contain that text string — the lockup layer owns it): subject with concrete visual detail, composition and framing, art style/technique, lighting, color palette, texture and finish quality terms. Faithful to the customer; add professional craft they didn't articulate. NEVER mention garments, panels, seams, mockups, or printing.
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
- layers: a grounded layout plan, ONLY when the customer names specific elements or exact text at specific positions/sizes ("my name small across the chest", "an anchor on the left sleeve", "this photo big in the middle"). NEVER use kind "text" — ALL placed text is kind "element" with a typography generation prompt that quotes the exact string, e.g.: the exact text "Gunner" rendered as playful hand-painted typography, single isolated text lockup, perfect spelling. Style the typography to match the customer's vibe (grungy, elegant script, varsity, neon...). "element" content is otherwise a rich standalone generation prompt for one isolated object. "customer_image" uses image_index. placement ("front" unless they say otherwise); cx_frac/cy_frac = the layer's center within the visible piece (0.5,0.5 = center of chest; 0.5,0.2 = high chest); width_frac = its width as a fraction of the piece width (small logo ~0.25, across-the-chest text ~0.7); rotation_deg (usually 0); order (background elements lower). Leave layers EMPTY for whole-scene artwork requests where text can flow inside the artwork of a single-panel product.
- layers_only: true when the design is NOTHING BUT the placed layers on the blank garment; false when the layers sit ON TOP of full artwork (e.g. "an AOP grunge shirt with '745' across the chest" = full artwork brief PLUS a layer, layers_only=false).
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
    /\baop\b|\ball[- ]?over\b|\bsublimation\b|\beverywhere\b|\bentire (shirt|hoodie|garment)\b|\bcovered (in|with)\b|\bwrap(ping|s)? around\b/i.test(
      text
    ),
  garment_color: "",
  size_preference: "",
  variant_hint: "",
  image_plan: [],
  layers: [],
  layers_only: false
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
