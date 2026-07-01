/**
 * Runware media toolkit: thin typed wrappers over the native task API for the
 * image tasks the pipeline uses.
 */

import { RunwareClient, RunwareTaskResult, sharedClient } from "./client.js";
import { IMAGE } from "./models.js";

export interface ImageResult extends RunwareTaskResult {
  imageURL: string;
  seed?: number;
  cost?: number;
}

export interface GenerateImageParams {
  model?: string;
  positivePrompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  referenceImages?: Array<{ image: string; role?: string } | string>;
  seed?: number;
  numberResults?: number;
  /** Seconds to retain the hosted output URL (default platform TTL is 7 days). */
  ttl?: number;
}

/** Clamp to FLUX.2 limits: 256-2048px in 16px increments. */
export const clampFluxDimension = (value: number): number => {
  const clamped = Math.min(2048, Math.max(256, Math.round(value)));
  return clamped - (clamped % 16);
};

export class RunwareMedia {
  constructor(private readonly client: RunwareClient = sharedClient()) {}

  /** Text-to-image / reference-guided generation. Returns a hosted public PNG URL. */
  async generateImage(params: GenerateImageParams): Promise<ImageResult> {
    const model = params.model ?? IMAGE.FLUX_2_FLEX;
    return this.client.runTask<ImageResult>({
      taskType: "imageInference",
      model,
      positivePrompt: params.positivePrompt,
      ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
      width: clampFluxDimension(params.width),
      height: clampFluxDimension(params.height),
      outputType: "URL",
      outputFormat: "PNG",
      numberResults: params.numberResults ?? 1,
      includeCost: true,
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
      ...(params.referenceImages?.length
        ? {
            inputs: {
              referenceImages: params.referenceImages.map((ref) =>
                typeof ref === "string" ? { image: ref } : ref
              )
            }
          }
        : {})
    });
  }

  /** BiRefNet General background removal; PNG output preserves transparency. */
  async removeBackground(imageUrl: string): Promise<ImageResult> {
    return this.client.runTask<ImageResult>({
      taskType: "removeBackground",
      model: IMAGE.BIREFNET_GENERAL,
      outputType: "URL",
      outputFormat: "PNG",
      outputQuality: 95,
      includeCost: true,
      inputs: { image: imageUrl }
    });
  }

  /** Print-resolution upscaling. Accepts a URL, image UUID, or base64/data URI. */
  async upscale(image: string, upscaleFactor: 2 | 3 | 4 = 2): Promise<ImageResult> {
    return this.client.runTask<ImageResult>({
      taskType: "imageUpscale",
      upscaleFactor,
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
      inputs: { image }
    });
  }

  /**
   * Upload image bytes (base64/data URI) or an external URL into Runware.
   * Returns an imageUUID referencable by any subsequent task. This is how
   * locally-sliced panels re-enter the platform: upload -> upscale/transform
   * -> hosted public output URL.
   */
  async uploadImage(image: string): Promise<string> {
    const result = await this.client.runTask<RunwareTaskResult & { imageUUID: string }>({
      taskType: "imageUpload",
      image
    });
    return result.imageUUID;
  }

  /** AI caption for a customer-supplied reference image. */
  async imageCaption(image: string): Promise<string> {
    const result = await this.client.runTask<RunwareTaskResult & { text?: string }>({
      taskType: "imageCaption",
      includeCost: true,
      inputs: { image }
    });
    return (result.text as string) ?? "";
  }

  /**
   * FLUX Virtual Try-On: renders a person wearing the supplied garment while
   * preserving face and pose. Garment prints/logos/stitching are transferred
   * with high fidelity.
   */
  async virtualTryOn(params: {
    personImageUrl: string;
    garmentImageUrl: string;
    garmentDescription: string;
  }): Promise<ImageResult> {
    return this.client.runTask<ImageResult>({
      taskType: "imageInference",
      model: IMAGE.FLUX_VTO,
      positivePrompt: `The person of image 1, maintaining exactly their face and pose, wearing the ${params.garmentDescription} of image 2.`,
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
      inputs: {
        referenceImages: [
          { image: params.personImageUrl, role: "person" },
          { image: params.garmentImageUrl, role: "garment" }
        ]
      }
    });
  }

  /** Optional prompt expansion before generation. */
  async promptEnhance(prompt: string, maxLength = 300): Promise<string> {
    const result = await this.client.runTask<RunwareTaskResult & { text?: string }>({
      taskType: "promptEnhance",
      prompt,
      promptMaxLength: maxLength,
      promptVersions: 1
    });
    return (result.text as string) ?? prompt;
  }

  /** Programmatic model discovery on the Runware catalog. */
  async modelSearch(params: {
    search?: string;
    category?: string;
    architecture?: string;
    tags?: string[];
  }): Promise<RunwareTaskResult> {
    return this.client.runTask({
      taskType: "modelSearch",
      ...params
    });
  }
}
