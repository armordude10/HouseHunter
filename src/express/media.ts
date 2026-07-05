/**
 * Express media selection: FLUX.2 [flex] on Runware is the preferred image
 * engine (proven lightyears better garment art), with automatic fallback to
 * the OpenAI adapter so an unfunded Runware wallet or an outage degrades one
 * run's engine instead of losing the sale.
 *
 * Fallback is STICKY per run: upload ids are backend-local (a Runware image
 * UUID means nothing to the OpenAI adapter), so after the first primary
 * failure the whole run continues on the secondary. Construct one instance
 * per run. Failures normally surface at generateImage — before any
 * upload/upscale pair — so pairs stay backend-consistent.
 *
 * THREADBOT_MEDIA=runware|openai pins a single backend (no fallback).
 */

import { MediaLike } from "../engine/panelCompiler.js";

class FallbackMedia implements MediaLike {
  private demoted = false;

  constructor(
    private readonly primary: MediaLike,
    private readonly secondary: MediaLike
  ) {}

  private async attempt<T>(op: string, call: (media: MediaLike) => Promise<T>): Promise<T> {
    if (this.demoted) return call(this.secondary);
    try {
      return await call(this.primary);
    } catch (error) {
      this.demoted = true;
      console.error(
        `[express-media] primary ${op} failed (${(error as Error).message.slice(0, 160)}); run continues on fallback engine`
      );
      return call(this.secondary);
    }
  }

  generateImage(params: Parameters<MediaLike["generateImage"]>[0]) {
    return this.attempt("generateImage", (media) => media.generateImage(params));
  }
  removeBackground(url: string) {
    return this.attempt("removeBackground", (media) => media.removeBackground(url));
  }
  async upscale(image: string, factor: 2 | 3 | 4) {
    // Mid-pair failures cannot cross backends (local upload id); fail the
    // panel honestly instead of feeding one backend another's id.
    return (this.demoted ? this.secondary : this.primary).upscale(image, factor);
  }
  uploadImage(image: string) {
    return (this.demoted ? this.secondary : this.primary).uploadImage(image);
  }
}

export const buildExpressMedia = async (): Promise<MediaLike> => {
  const preference = (process.env.THREADBOT_MEDIA ?? "").toLowerCase();
  const hasRunware = Boolean(process.env.RUNWARE_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

  const runware = async () => new (await import("../runware/media.js")).RunwareMedia();
  const openai = async () => new (await import("../llm/openaiMedia.js")).OpenAIMedia();

  if (preference === "openai" || !hasRunware) return openai();
  if (preference === "runware" || !hasOpenAI) return runware();
  // Default: gpt-image-1.5 first (native transparent layers for the layered
  // composition engine), FLUX.2 flex as the safety net. One instance per run.
  return new FallbackMedia(await openai(), await runware());
};
