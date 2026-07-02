/**
 * Runware media toolkit: thin typed wrappers over the native task API for the
 * image tasks the pipeline uses.
 */

import { RunwareClient, RunwareTask, RunwareTaskResult, sharedClient } from "./client.js";
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
  /**
   * Native transparent-background generation (LayerDiffuse). Supported on
   * FLUX.1 architecture models (e.g. runware:101@1); FLUX.2 rejects it.
   */
  layerDiffuse?: boolean;
}

/** Clamp to FLUX.2 limits: 256-2048px in 16px increments. */
export const clampFluxDimension = (value: number): number => {
  const clamped = Math.min(2048, Math.max(256, Math.round(value)));
  return clamped - (clamped % 16);
};

export class RunwareMedia {
  constructor(private readonly client: RunwareClient = sharedClient()) {}

  /**
   * Text-to-image / reference-guided generation. Returns a hosted public PNG
   * URL. Parameter support varies per model (e.g. FLUX.2 rejects
   * negativePrompt), so on an `invalidParameter` error the offending
   * parameter is stripped and the task retried.
   */
  async generateImage(params: GenerateImageParams): Promise<ImageResult> {
    const model = params.model ?? IMAGE.FLUX_2_FLEX;
    const task: Record<string, unknown> = {
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
      ...(params.layerDiffuse ? { advancedFeatures: { layerDiffuse: true } } : {}),
      ...(params.referenceImages?.length
        ? {
            inputs: {
              // Plain URL/UUID strings — the {image, role} object form is
              // only valid for Virtual Try-On.
              referenceImages: params.referenceImages.map((ref) =>
                typeof ref === "string" ? ref : ref.image
              )
            }
          }
        : {})
    };
    return this.runTaskStrippingUnsupported<ImageResult>(task);
  }

  /** Run a task, dropping any parameter the model reports as unsupported. */
  private async runTaskStrippingUnsupported<T extends RunwareTaskResult>(
    task: Record<string, unknown>,
    maxRepairs = 3
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.runTask<T>(task as RunwareTask);
      } catch (error) {
        const details = (error as { details?: unknown }).details;
        const errorList = Array.isArray(details)
          ? details
          : ((details as { errors?: unknown[] } | undefined)?.errors ?? []);
        const invalid = (errorList as Array<{ code?: string; parameter?: string }>).find(
          (item) => item.code === "invalidParameter" && item.parameter && item.parameter in task
        );
        if (!invalid?.parameter || attempt >= maxRepairs) throw error;
        delete task[invalid.parameter];
      }
    }
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
  async upscale(
    image: string,
    upscaleFactor: 2 | 3 | 4 = 2,
    outputFormat: "PNG" | "JPG" = "PNG"
  ): Promise<ImageResult> {
    return this.client.runTask<ImageResult>({
      taskType: "imageUpscale",
      upscaleFactor,
      outputType: "URL",
      outputFormat,
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
