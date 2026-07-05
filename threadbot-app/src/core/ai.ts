/**
 * The "brain": parse one messy (optionally multimodal) prompt into a product
 * selection + artwork brief, and generate the print-ready artwork.
 *
 * This replaces ~10 of the old sequential agents with one understand+select call
 * plus one image generation. The provider/commerce core does the rest deterministically.
 *
 * `Brain` is an interface so the deterministic pipeline can be exercised with
 * `FakeBrain` (no API keys, used by local runs/tests).
 */

import OpenAI, { toFile } from "openai";
import sharp from "sharp";

export interface CatalogProduct {
  id: string;
  name: string;
  keywords: string[];
  defaultColor: string;
  default?: boolean;
  technique: string;
  primaryPlacement: string;
  providers: { printful?: { productId: number } };
}

/** A piece of text the customer wants printed at a specific spot on the product. */
export interface TextPlacement {
  /** Best-guess panel: "front" | "back" | "left_sleeve" | "right_sleeve". */
  area: string;
  /** The exact characters to print, spelled/cased as the customer wrote them. */
  text: string;
  /** Short human note, e.g. "centered chest", "upper back". */
  position?: string;
}

export interface Understanding {
  neutralProductId: string;
  color: string;
  size: string; // concrete or "UNRESOLVED"
  placement: string;
  technique: string;
  /** For all-over products: a repeating pattern vs a single scene that wraps the garment. */
  designStyle: "pattern" | "scene";
  artworkBrief: string;
  /** Text the customer asked to appear at specific spots; rendered in a dedicated pass. */
  textPlacements: TextPlacement[];
  policy: { status: "allow" | "review" | "block"; reason?: string };
}

export interface UnderstandInput {
  prompt: string;
  imageUrls?: string[];
  catalog: CatalogProduct[];
  defaultSize?: string;
}

export interface Brain {
  understandAndSelect(input: UnderstandInput): Promise<Understanding>;
  generateArtwork(
    brief: string,
    opts?: { imageUrls?: string[]; transparent?: boolean; inkColor?: string }
  ): Promise<{ buffer: Buffer; mime: string }>;
  /**
   * Second pass: add the requested text onto an already-rendered panel image,
   * without changing the existing art, composition, or aspect ratio. Returns a
   * buffer at the SAME pixel dimensions as the input so panel alignment is kept.
   */
  addText(panel: Buffer, items: TextPlacement[], panelLabel: string, transparent?: boolean): Promise<{ buffer: Buffer; mime: string }>;
}

const SYSTEM = `You are the design compiler for a print-on-demand store.
The customer sends ONE messy prompt (sometimes with an image). You never ask follow-up questions.

PRODUCT SELECTION
- Pick the single best product from the provided catalog.
- If the prompt names or implies a product type (hoodie, tee, leggings, tote, jersey, hat, mug,
  tank top, sweatshirt, joggers, etc.), select a catalog item of that EXACT type.
- ALL-OVER INTENT: if the customer says the design should cover the WHOLE/ENTIRE garment, be
  "all over", a "mural", "wrap around", or go "edge to edge", PREFER the catalog's all-over /
  cut-sew / sublimation version of that garment type when one exists (its technique is one of
  cut-sew, aop, or sublimation). Only fall back to a standard (DTG) version if no all-over
  version of that garment is in the catalog.
- If the prompt only describes artwork and names no product, pick the item marked default:true (a tee).
- Never pick tapestries, bags, posters, blankets, or accessories for a prompt that only describes a graphic.

COLOR / SIZE / PLACEMENT
- Infer color from the prompt; if unstated use the product's defaultColor.
- Only set a concrete size if the prompt explicitly states one; otherwise return "UNRESOLVED".
- Anchor placement is the product's primaryPlacement unless the prompt clearly implies another.

ARTWORK BRIEF — describe ONLY the artwork/graphic that gets printed. This is the IMAGE, not the garment.
- NEVER mention the garment, the product type, the garment's color, a shirt/hoodie/jersey, a mockup,
  a model, a hanger, tags, or fabric in the brief. Describing the garment makes the printer draw a
  picture of a shirt ON a shirt. Even when the customer phrases it as "a red shirt that says X",
  treat that as "the artwork that goes ON the product" — the brief is just the design itself.
- Write a vivid, self-contained description of the graphic only: subjects, style, composition, colors,
  fusing everything the customer described (and anything visible in an attached image).
- Do not reference real brands, logos, or real people. Never mention the supplier or the catalog.
- For all-over / cut-sew products, make the brief a seamless, edge-to-edge, full-bleed composition
  (not a single centered motif).
- COLOR: treat the customer's requested color as the DOMINANT palette of the design (e.g. "yellow
  hoodie" => a yellow-dominant artwork). For all-over products the color IS the look. Never describe
  the garment itself — only the design's palette.

designStyle is "pattern" for a repeating motif/texture, or "scene" when the user describes a single
subject/scene that should appear once and wrap the product. Default to "pattern". For a "scene", write
the brief with the main subject centered and the scene extending to every edge.

TEXT PLACEMENT — when the customer asks for specific words, letters, or numbers on the product:
- Return them in textPlacements: [{ area, text, position }].
  area is the best-guess panel, one of: "front", "back", "left_sleeve", "right_sleeve"
  (use "front" for chest text and for products that only have a front).
  text is the EXACT characters to print, spelled and cased exactly as the customer wrote them.
  position is a short note such as "centered chest", "upper back", or "small left chest".
- Do NOT spell the placed words into artworkBrief — the words are added later in a precise pass.
  Instead, leave clean, uncluttered space in the artwork where each text will sit.
- If no specific text is requested, return textPlacements: [].

POLICY — be deterministic and permissive.
- status "allow" for the vast majority of requests, INCLUDING the customer's own or made-up brand,
  team, band, or business names (a construction company name, a made-up team name, etc.), generic
  words, and ordinary slang. A brand-like or edgy word is NOT a reason to block.
- status "block" ONLY for genuinely unsafe content (sexual content involving minors, credible
  real-world violence or weapons instructions, hateful content targeting protected groups) or clear
  infringement of a FAMOUS third-party trademark or a real, identifiable person's likeness.
- When unsure, "allow".

Return ONLY JSON:
{neutralProductId, color, size, placement, technique, designStyle, artworkBrief, textPlacements, policy:{status,reason}}.`;

export class OpenAIBrain implements Brain {
  private client: OpenAI;
  constructor(
    apiKey: string,
    private textModel: string,
    private imageModel: string,
    private imageSize: string
  ) {
    // Accept-Encoding: identity — some container hosts (HF Spaces) cut gzip'd
    // response streams mid-transfer ("Premature close"); plain responses are fine.
    this.client = new OpenAI({
      apiKey,
      maxRetries: 6,
      timeout: 120_000,
      defaultHeaders: { "Accept-Encoding": "identity" },
    });
  }

  async understandAndSelect(input: UnderstandInput): Promise<Understanding> {
    const catalogBrief = input.catalog.map((p) => ({
      id: p.id,
      name: p.name,
      keywords: p.keywords,
      defaultColor: p.defaultColor,
      default: !!p.default,
      technique: p.technique,
      primaryPlacement: p.primaryPlacement,
    }));

    const userContent: any[] = [
      {
        type: "text",
        text: `CATALOG:\n${JSON.stringify(catalogBrief)}\n\nDEFAULT_SIZE: ${
          input.defaultSize ?? "none"
        }\n\nCUSTOMER PROMPT:\n${input.prompt}`,
      },
    ];
    for (const url of input.imageUrls ?? []) {
      userContent.push({ type: "image_url", image_url: { url } });
    }

    const resp = await this.client.chat.completions.create({
      model: this.textModel,
      response_format: { type: "json_object" },
      // No temperature/seed: GPT-5.x reasoning models only accept the default temperature.
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userContent },
      ],
    });

    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    return this.normalize(parsed, input);
  }

  private normalize(parsed: any, input: UnderstandInput): Understanding {
    const fallback =
      input.catalog.find((p) => p.default) ?? input.catalog[0];
    const product =
      input.catalog.find((p) => p.id === parsed.neutralProductId) ?? fallback;
    return {
      neutralProductId: product.id,
      color: typeof parsed.color === "string" && parsed.color ? parsed.color : product.defaultColor,
      size: typeof parsed.size === "string" && parsed.size ? parsed.size : input.defaultSize ?? "UNRESOLVED",
      placement: parsed.placement || product.primaryPlacement,
      technique: parsed.technique || product.technique,
      designStyle: parsed.designStyle === "scene" ? "scene" : "pattern",
      artworkBrief: parsed.artworkBrief || input.prompt,
      textPlacements: normalizeTextPlacements(parsed.textPlacements),
      policy:
        parsed.policy && parsed.policy.status
          ? parsed.policy
          : { status: "allow" },
    };
  }

  async generateArtwork(
    brief: string,
    opts: { imageUrls?: string[]; transparent?: boolean; inkColor?: string } = {}
  ): Promise<{ buffer: Buffer; mime: string }> {
    // graphic (DTG): a full-colour shirt graphic fused from the customer's text/image, on a
    // fully transparent, soft-edged background (never a box). all-over: a full-bleed design.
    const prompt = opts.transparent
      ? `${brief}\n\nProduce ONE cohesive shirt graphic, fusing everything the customer described (and any attached image) into a single design. HARD RULES:\n- Output a PNG with a FULLY TRANSPARENT (alpha) background. The design elements sit DIRECTLY on transparency with nothing behind them.\n- Do NOT enclose the design in a box, rectangle, badge plate, shield, banner, circle, or any filled backdrop — only the actual subject is drawn; everything else is transparent.\n- Clean, soft edges — no hard rectangular border.\n- ARTWORK ONLY: never a shirt, garment, hanger, fabric, mockup, tag, or a person wearing it.\n- Full colour, high detail, print-ready, centered with even margins.`
      : `${brief}\n\nThis is the ARTWORK GRAPHIC ONLY, to be printed onto a product. Do NOT draw a shirt, hoodie, jersey, garment, fabric, mockup, hanger, tag, or a person wearing it. Full-bleed, edge to edge, print-ready.`;

    const gen: any = { model: this.imageModel, prompt, size: this.imageSize };
    if (opts.transparent) { gen.background = "transparent"; gen.output_format = "png"; }

    // Fusion: if the customer attached image(s), edit from them instead of pure text-to-image.
    const item =
      opts.imageUrls && opts.imageUrls.length
        ? await this.editFromImage(prompt, opts.imageUrls[0], opts.transparent)
        : (await this.client.images.generate(gen)).data?.[0];

    const i = item as any;
    if (i?.b64_json) return { buffer: Buffer.from(i.b64_json, "base64"), mime: "image/png" };
    if (i?.url) {
      const r = await fetch(i.url);
      return { buffer: Buffer.from(await r.arrayBuffer()), mime: "image/png" };
    }
    throw new Error("Image generation returned no data");
  }

  private async editFromImage(prompt: string, imageUrl: string, transparent = false) {
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error(`fetch input image failed ${r.status} for ${imageUrl}`);
    const image = await toFile(Buffer.from(await r.arrayBuffer()), "input.png", { type: "image/png" });
    const req: any = { model: this.imageModel, image, prompt, size: this.imageSize };
    if (transparent) { req.background = "transparent"; req.output_format = "png"; }
    const resp = await this.client.images.edit(req);
    return resp.data?.[0];
  }

  async addText(
    panel: Buffer,
    items: TextPlacement[],
    panelLabel: string,
    transparent = false
  ): Promise<{ buffer: Buffer; mime: string }> {
    if (!items.length) return { buffer: panel, mime: "image/png" };
    const meta = await sharp(panel).metadata();
    const w = meta.width ?? 1024;
    const h = meta.height ?? 1024;

    const lines = items
      .map((it) => `• "${it.text}"${it.position ? ` (${it.position})` : ""}`)
      .join("\n");
    const bgRule = transparent
      ? ` Keep the background FULLY TRANSPARENT — do not add any background fill, box, panel, or colour behind the artwork or the text.`
      : "";
    const prompt = `This image is the finished printed artwork for the ${panelLabel} of a garment. Add the following text onto it, spelled and cased EXACTLY as written, in bold, legible, print-quality lettering that fits the artwork's existing style and color palette and contrasts the background so it reads clearly:\n${lines}\n\nStrict rules: keep ALL of the existing artwork, colors, and composition exactly as they are; ONLY add the specified text. Place every text element FULLY INSIDE the central safe area with generous margins from all four edges, so no letters are cropped. Do not add any other words, letters, watermarks, or signatures. Do not crop, zoom, rotate, reframe, or change the aspect ratio. Return the full image.${bgRule}`;

    const image = await toFile(panel, "panel.png", { type: "image/png" });
    const editReq: any = { model: this.imageModel, image, prompt, size: nearestEditSize(w, h) };
    if (transparent) { editReq.background = "transparent"; editReq.output_format = "png"; }
    const resp = await this.client.images.edit(editReq);
    const it = resp.data?.[0] as any;
    let out: Buffer;
    if (it?.b64_json) out = Buffer.from(it.b64_json, "base64");
    else if (it?.url) out = Buffer.from(await (await fetch(it.url)).arrayBuffer());
    else throw new Error("addText returned no image data");

    // Force back to the panel's exact pixel size so printfile geometry stays aligned.
    const fixed = await sharp(out).resize(w, h, { fit: "fill" }).png().toBuffer();
    return { buffer: fixed, mime: "image/png" };
  }
}

/** Closest gpt-image edit size to a panel's aspect ratio (the API only emits these). */
function nearestEditSize(w: number, h: number): "1024x1024" | "1536x1024" | "1024x1536" {
  const ratio = w / h;
  if (ratio >= 1.25) return "1536x1024";
  if (ratio <= 0.8) return "1024x1536";
  return "1024x1024";
}

/** Sanitize the model's textPlacements into clean {area,text,position} rows. */
function normalizeTextPlacements(raw: any): TextPlacement[] {
  if (!Array.isArray(raw)) return [];
  const out: TextPlacement[] = [];
  for (const r of raw) {
    const text = typeof r?.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    const area = typeof r?.area === "string" && r.area.trim() ? r.area.trim().toLowerCase() : "front";
    const position = typeof r?.position === "string" && r.position.trim() ? r.position.trim() : undefined;
    out.push({ area, text, position });
  }
  return out;
}

/** No external calls. Picks the default product and paints a solid placeholder. */
export class FakeBrain implements Brain {
  async understandAndSelect(input: UnderstandInput): Promise<Understanding> {
    const product = input.catalog.find((p) => p.default) ?? input.catalog[0];
    return {
      neutralProductId: product.id,
      color: product.defaultColor,
      size: input.defaultSize ?? "UNRESOLVED",
      placement: product.primaryPlacement,
      technique: product.technique,
      designStyle: "pattern",
      artworkBrief: input.prompt,
      textPlacements: [],
      policy: { status: "allow" },
    };
  }

  async generateArtwork(): Promise<{ buffer: Buffer; mime: string }> {
    const buffer = await sharp({
      create: { width: 1024, height: 1536, channels: 4, background: { r: 230, g: 60, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer();
    return { buffer, mime: "image/png" };
  }

  /** No-op second pass — the deterministic pipeline keeps the panel unchanged. */
  async addText(panel: Buffer): Promise<{ buffer: Buffer; mime: string }> {
    return { buffer: panel, mime: "image/png" };
  }
}
