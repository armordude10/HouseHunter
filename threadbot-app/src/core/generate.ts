/**
 * The mobile UI's single backend call. threadbot-api.js posts { prompt, refImage,
 * remix, baseImage } and expects { variations: [{ id, image }] }. We fan that out
 * to the verified preview pipeline (reusing fusion for refImage / remix).
 */

import { generateVariationRenders, type PreviewDeps } from "./preview.js";

export interface GenerateRequest {
  prompt: string;
  refImage?: string | null;
  remix?: boolean;
  baseImage?: string | null;
  defaultSize?: string;
  count?: number;
}

export interface Variation {
  id: string;
  image: string | null;
  error?: string;
}

export interface GenerateResult {
  variations: Variation[];
}

export async function generateVariations(
  deps: PreviewDeps,
  req: GenerateRequest
): Promise<GenerateResult> {
  const count = Math.max(1, Math.min(req.count ?? 1, 4));

  // remix=true mutates the current render (img2img). Otherwise an optional reference.
  const imageUrls =
    req.remix && req.baseImage ? [req.baseImage] : req.refImage ? [req.refImage] : undefined;

  // Understand the prompt ONCE, then fan out only the image renders — one gpt-5.5 call per tap,
  // not one per variation.
  const results = await generateVariationRenders(
    deps,
    { prompt: req.prompt, imageUrls, defaultSize: req.defaultSize },
    count
  );

  const variations = results.map((r, i) => {
    if (r.previewImageUrl) return { id: r.designId ?? `v${Date.now()}-${i}`, image: r.previewImageUrl };
    const msg = `status=${r.status}: ${r.message ?? "no preview url"}`;
    console.error(`[generate] variation ${i} produced no image:`, msg);
    return { id: r.designId ?? `v${Date.now()}-${i}`, image: null, error: msg };
  });

  return { variations };
}
