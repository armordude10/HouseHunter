/**
 * Deterministic raster operations (sharp). These are the "scissors" of the
 * garment-space compiler: exact crops, exact tiling, exact resizes, correct
 * DPI metadata. Nothing here is generative, so nothing here can drift.
 */

import sharp, { type OverlayOptions } from "sharp";

// Print-res panels decode to 90-140MB; sharp's default cache holds recent
// buffers and pushes a memory-capped container toward OOM during the
// slice/overlay passes (the "nothing came back" failure on 4-panel AOP).
// Throughput is bounded by generation latency, not raster cache hits.
sharp.cache({ memory: 64, files: 0, items: 32 });

export interface RasterImage {
  buffer: Buffer;
  width: number;
  height: number;
}

export const fetchImage = async (url: string): Promise<RasterImage> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width ?? 0, height: meta.height ?? 0 };
};

export interface CropSpec {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Resize the crop to this exact output size. */
  outWidth: number;
  outHeight: number;
  dpi: number;
}

/** Exact crop + resize + DPI-stamped PNG. */
export const cropExact = async (image: RasterImage, spec: CropSpec): Promise<Buffer> => {
  const left = Math.max(0, Math.min(Math.round(spec.left), image.width - 1));
  const top = Math.max(0, Math.min(Math.round(spec.top), image.height - 1));
  const width = Math.max(1, Math.min(Math.round(spec.width), image.width - left));
  const height = Math.max(1, Math.min(Math.round(spec.height), image.height - top));
  return sharp(image.buffer)
    .extract({ left, top, width, height })
    .resize(spec.outWidth, spec.outHeight, { fit: "fill" })
    .withMetadata({ density: spec.dpi })
    .png()
    .toBuffer();
};

export interface TileSpec {
  outWidth: number;
  outHeight: number;
  /** Tile size in output pixels. */
  tileWidth: number;
  tileHeight: number;
  /** Phase offset of the tile grid in output pixels (garment-space modulo). */
  offsetX: number;
  offsetY: number;
  dpi: number;
}

/**
 * Deterministically tile a seamless swatch across a panel. Cross-panel
 * continuity comes from the caller computing offsetX/offsetY as the panel's
 * position on the garment plane modulo the tile size: every panel samples the
 * same infinite tiled plane, so patterns line up across seams exactly.
 */
export const tileExact = async (tile: RasterImage, spec: TileSpec): Promise<Buffer> => {
  const tileBuffer = await sharp(tile.buffer)
    .resize(Math.max(1, Math.round(spec.tileWidth)), Math.max(1, Math.round(spec.tileHeight)), {
      fit: "fill"
    })
    .png()
    .toBuffer();
  const tileW = Math.max(1, Math.round(spec.tileWidth));
  const tileH = Math.max(1, Math.round(spec.tileHeight));
  const phaseX = ((Math.round(spec.offsetX) % tileW) + tileW) % tileW;
  const phaseY = ((Math.round(spec.offsetY) % tileH) + tileH) % tileH;

  const composites: OverlayOptions[] = [];
  for (let y = -phaseY; y < spec.outHeight; y += tileH) {
    for (let x = -phaseX; x < spec.outWidth; x += tileW) {
      composites.push({ input: tileBuffer, left: x, top: y });
    }
  }
  return sharp({
    create: {
      width: spec.outWidth,
      height: spec.outHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .withMetadata({ density: spec.dpi })
    .png()
    .toBuffer();
};

/** Horizontal mirror (deterministic mirror_from_pair support). */
export const mirrorHorizontal = async (image: RasterImage, dpi: number): Promise<Buffer> =>
  sharp(image.buffer).flop().withMetadata({ density: dpi }).png().toBuffer();

export const toBase64Png = (buffer: Buffer): string =>
  `data:image/png;base64,${buffer.toString("base64")}`;

export const imageDimensions = async (buffer: Buffer) => {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
};

/** Solid test swatch used by the offline self-check. */
export const solidPng = async (width: number, height: number, rgb: [number, number, number]) => {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 }
    }
  })
    .png()
    .toBuffer();
  return { buffer, width, height } satisfies RasterImage;
};
