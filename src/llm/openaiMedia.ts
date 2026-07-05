/**
 * OpenAI-backed MediaLike adapter: lets the express path (and the Panel
 * Compiler generally) run end-to-end on an OpenAI key when Runware credits
 * are unavailable.
 *
 * Cost shape per express run stays cents:
 *   - generateImage    gpt-image-1 (~$0.04-0.07 at medium quality) — the ONE
 *     paid image call per run
 *   - upscale          local sharp resize, $0 (resolution + hosting only)
 *   - uploadImage      in-process store, $0
 *   - removeBackground deterministic corner-keyed alpha via sharp, $0
 *
 * Generated pixels are hosted on this service's own /uploads route
 * (src/hosting.ts) — THREADBOT_PUBLIC_URL must be the service's public URL so
 * Printful can fetch the print files.
 */

import sharp from "sharp";
import { MediaLike } from "../engine/panelCompiler.js";
import { hostedImageUrl, putHostedImage } from "../hosting.js";

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const IMAGE_MODEL = () => process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
const IMAGE_QUALITY = () => process.env.OPENAI_IMAGE_QUALITY ?? "medium";

/** gpt-image-1 generates at fixed sizes; we pick by aspect and resample. */
const pickSize = (width: number, height: number): string => {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.2) return "1536x1024";
  if (ratio < 0.83) return "1024x1536";
  return "1024x1024";
};

export class OpenAIMedia implements MediaLike {
  private readonly apiKey: string;
  /** Local working buffers keyed by upload id (mirrors Runware's UUID flow). */
  private buffers = new Map<string, Buffer>();

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set (OpenAI media adapter)");
    this.apiKey = apiKey;
  }

  async generateImage(params: {
    model?: string;
    positivePrompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    referenceImages?: Array<{ image: string; role?: string } | string>;
    seed?: number;
  }): Promise<{ imageURL: string }> {
    // No negative-prompt channel: fold it into the prompt.
    const prompt = [
      params.positivePrompt.slice(0, 3600),
      params.negativePrompt ? `Strictly avoid: ${params.negativePrompt.slice(0, 300)}.` : ""
    ]
      .filter(Boolean)
      .join(" ");

    const references = (params.referenceImages ?? [])
      .map((ref) => (typeof ref === "string" ? ref : ref.image))
      .filter((url) => /^https?:\/\//.test(url))
      .slice(0, 4);

    let b64: string;
    if (references.length) {
      // Image-guided generation via the edits endpoint (multipart).
      const form = new FormData();
      form.append("model", IMAGE_MODEL());
      form.append("prompt", prompt.slice(0, 4000));
      form.append("size", pickSize(params.width, params.height));
      form.append("quality", IMAGE_QUALITY());
      for (const [i, url] of references.entries()) {
        const response = await fetch(url);
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        form.append("image[]", new Blob([bytes], { type: "image/png" }), `ref-${i}.png`);
      }
      b64 = await this.postImages("/images/edits", form);
    } else {
      b64 = await this.postImages(
        "/images/generations",
        JSON.stringify({
          model: IMAGE_MODEL(),
          prompt: prompt.slice(0, 4000),
          size: pickSize(params.width, params.height),
          quality: IMAGE_QUALITY()
        })
      );
    }

    // Resample to the exact requested canvas (the compiler's pixel math
    // depends on exact dimensions), then host.
    const exact = await sharp(Buffer.from(b64, "base64"))
      .resize(Math.round(params.width), Math.round(params.height), { fit: "fill" })
      .png()
      .toBuffer();
    return { imageURL: hostedImageUrl(putHostedImage(exact)) };
  }

  private async postImages(path: string, body: string | FormData): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(typeof body === "string" ? { "Content-Type": "application/json" } : {})
        },
        body
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 2500 * attempt));
        continue;
      }
      const parsed = (await response.json().catch(() => null)) as {
        data?: Array<{ b64_json?: string }>;
        error?: { message?: string };
      } | null;
      if (!response.ok || !parsed?.data?.[0]?.b64_json) {
        throw new Error(
          `OpenAI ${path} HTTP ${response.status}: ${
            parsed?.error?.message ?? JSON.stringify(parsed)?.slice(0, 200)
          }`
        );
      }
      return parsed.data[0].b64_json;
    }
  }

  async uploadImage(image: string): Promise<string> {
    const id = `local-${this.buffers.size}-${Date.now()}`;
    this.buffers.set(id, Buffer.from(image.replace(/^data:[^,]*,/, ""), "base64"));
    return id;
  }

  /** Resolution + hosting only — pure local resample, $0. */
  async upscale(image: string, factor: 2 | 3 | 4): Promise<{ imageURL: string }> {
    const source =
      this.buffers.get(image) ??
      (image.startsWith("http")
        ? Buffer.from(await (await fetch(image)).arrayBuffer())
        : Buffer.from(image.replace(/^data:[^,]*,/, ""), "base64"));
    this.buffers.delete(image);
    const meta = await sharp(source).metadata();
    const out = await sharp(source)
      .resize((meta.width ?? 1) * factor, (meta.height ?? 1) * factor, {
        fit: "fill",
        kernel: "lanczos3"
      })
      .png()
      .toBuffer();
    return { imageURL: hostedImageUrl(putHostedImage(out)) };
  }

  /**
   * Deterministic background removal: key out the corner-sampled background
   * color with a feathered threshold. Suits flat-background cutout art (the
   * only case the compiler requests); $0 and dependency-free.
   */
  async removeBackground(imageUrl: string): Promise<{ imageURL: string }> {
    const source = Buffer.from(await (await fetch(imageUrl)).arrayBuffer());
    const { data, info } = await sharp(source)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const corners = [
      px(0, 0),
      px(info.width - 1, 0),
      px(0, info.height - 1),
      px(info.width - 1, info.height - 1)
    ];
    const bg = [0, 1, 2].map((c) => corners.reduce((s, p) => s + p[c], 0) / corners.length);
    const NEAR = 28;
    const FAR = 64;
    for (let i = 0; i < data.length; i += info.channels) {
      const dist = Math.sqrt(
        (data[i] - bg[0]) ** 2 + (data[i + 1] - bg[1]) ** 2 + (data[i + 2] - bg[2]) ** 2
      );
      if (dist < NEAR) data[i + 3] = 0;
      else if (dist < FAR) {
        data[i + 3] = Math.min(data[i + 3], Math.round(((dist - NEAR) / (FAR - NEAR)) * 255));
      }
    }
    const out = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels as 4 }
    })
      .png()
      .toBuffer();
    return { imageURL: hostedImageUrl(putHostedImage(out)) };
  }
}
