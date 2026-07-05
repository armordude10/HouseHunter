/**
 * gpt-image-1.5 honors background:transparent and returns a real transparent PNG. We don't need
 * to invent transparency — we just (a) feather the existing alpha a touch for clean edges and
 * (b) crop to the design's opaque bounding box so it SCALES to fill the print area instead of
 * sitting small inside a mostly-empty canvas.
 *
 * This uses the REAL alpha channel (never color-keying), so dark/black designs are never harmed.
 * If the image has no transparency (e.g. a text pass flattened it), the bbox is the whole frame
 * and nothing is cropped — safe.
 */
import sharp from "sharp";

export async function cutoutBackground(
  input: Buffer,
  opts: { feather?: number; pad?: number; trim?: boolean } = {}
): Promise<Buffer> {
  const feather = opts.feather ?? 1.0;
  const pad = opts.pad ?? 12;
  const trim = opts.trim ?? true;

  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const N = W * H;
  if (!W || !H) return await sharp(input).png().toBuffer();

  // Bounding box of the opaque design.
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3] > 24) {
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return await sharp(input).png().toBuffer(); // fully transparent — nothing to do

  // Feather the existing alpha for soft edges (1-channel blur; extractChannel keeps it 1-ch).
  let buf = input;
  if (feather > 0) {
    const alpha = Buffer.alloc(N);
    for (let i = 0; i < N; i++) alpha[i] = data[i * 4 + 3];
    const soft = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } })
      .blur(feather)
      .extractChannel(0)
      .raw()
      .toBuffer();
    const out = Buffer.alloc(N * 4);
    for (let i = 0; i < N; i++) {
      out[i * 4] = data[i * 4];
      out[i * 4 + 1] = data[i * 4 + 1];
      out[i * 4 + 2] = data[i * 4 + 2];
      out[i * 4 + 3] = soft[i];
    }
    buf = await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  }

  if (!trim) return await sharp(buf).png().toBuffer();
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const width = Math.min(W - left, maxX - minX + 1 + pad * 2);
  const height = Math.min(H - top, maxY - minY + 1 + pad * 2);
  return await sharp(buf).extract({ left, top, width, height }).png().toBuffer();
}
