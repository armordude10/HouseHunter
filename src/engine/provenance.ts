/**
 * Design genome: full deterministic provenance for every panel.
 *
 * Two properties make output predictable and reproducible:
 *  1. Seeds are derived (FNV-1a) from run_id + job_id + placement, so a rerun
 *     of the same run produces the same generations.
 *  2. Every panel records exactly how it was made — strategy, model, seed,
 *     prompt, garment-plane rect, crop/tile math, upscale factor — so any
 *     panel can be regenerated bit-compatibly or audited later.
 */

export const stableSeed = (...parts: Array<string | number>): number => {
  let hash = 0x811c9dc5;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Keep within a comfortable positive integer range for image APIs.
  return hash % 2147483647;
};

export interface PanelProvenance {
  job_id: string;
  placement: string;
  strategy: "direct" | "master_slice" | "pattern_tile" | "mirror" | "reference_derive" | "blank";
  model: string | null;
  seed: number | null;
  prompt: string | null;
  plane_rect_in: { x: number; y: number; w: number; h: number } | null;
  crop_px: { left: number; top: number; width: number; height: number } | null;
  tile_phase_px: { x: number; y: number } | null;
  upscale_factor: number | null;
  target_px: { width: number; height: number };
  dpi: number;
  transparent: boolean;
  source_urls: string[];
  printful_file_id: number | string | null;
}

export interface DesignGenome {
  version: "threadbot-genome/1";
  run_id: string;
  strategy: string;
  master_artwork_url: string | null;
  pattern_tile_url: string | null;
  panels: PanelProvenance[];
}
