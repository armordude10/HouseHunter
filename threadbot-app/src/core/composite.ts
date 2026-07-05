/**
 * Deterministic preview compositor.
 *
 * Overlays the exact print-ready art onto the provider's blank mockup image using
 * the print-area geometry. No generative model touches this image, so the preview
 * is a faithful rendering of the same file + position that the order will carry.
 */

import sharp from "sharp";
import type { PlacementGeometry, PrintPosition } from "../providers/types.js";
import { artRectInBaseImage } from "./position.js";

export async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function imageSize(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

export interface CompositeArgs {
  baseImageUrl: string;
  geometry: PlacementGeometry;
  artBuffer: Buffer;
  position: PrintPosition;
}

export async function compositePreview(args: CompositeArgs): Promise<Buffer> {
  const baseBuf = await fetchBuffer(args.baseImageUrl);
  const base = await imageSize(baseBuf);

  const rect = artRectInBaseImage(args.position, args.geometry, base.width, base.height);

  const art = await sharp(args.artBuffer)
    .resize(rect.width, rect.height, { fit: "fill" })
    .png()
    .toBuffer();

  return sharp(baseBuf)
    .composite([{ input: art, left: rect.left, top: rect.top }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
