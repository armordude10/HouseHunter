/**
 * Measured provider calibration profiles.
 *
 * Values come from rendering labeled calibration grids through Printful's
 * real Mockup Generator (scripts/calibrate.ts) and reading back which region
 * of each placement's file canvas lands on the sewn piece. Products not
 * listed fall back to piece == full canvas.
 *
 * pieceWFrac/pieceHFrac  visible piece size as a fraction of the canvas
 * pieceCxFrac/pieceCyFrac  piece center within the canvas (fractions)
 * anchor  anatomical piece-center offset from another placement's piece
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { CalibrationProfile } from "./garmentSpace.js";

/**
 * Analytic catalog-wide profiles (data/printful-calibration.json), computed
 * from Printful's own mockup-template geometry by scripts/build-calibration.ts.
 * These take precedence; the hand-measured built-ins below are the fallback.
 */
const loadCatalogProfiles = (): Record<string, CalibrationProfile> => {
  const candidates = [
    path.resolve(process.cwd(), "data/printful-calibration.json"),
    // Module-relative: <root>/dist/engine/… or <root>/src/engine/… -> <root>/data/…
    new URL("../../data/printful-calibration.json", import.meta.url).pathname
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        profiles?: Record<string, CalibrationProfile>;
      };
      if (parsed.profiles) return parsed.profiles;
    } catch {
      // try next candidate
    }
  }
  return {};
};

const CATALOG_PROFILES = loadCatalogProfiles();

/**
 * Empirical corrections layered over the analytic catalog profiles —
 * measured with real Printful mockup renders where template geometry is
 * proven unreliable (e.g. pocket canvases are not co-aligned with fronts;
 * see out/calibration/pocket-truth.jpg).
 */
const EMPIRICAL_OVERRIDES: Record<number, CalibrationProfile> = {
  388: {
    pocket: {
      pieceWFrac: 0.32,
      pieceHFrac: 0.19,
      pieceCxFrac: 0.49,
      pieceCyFrac: 0.5,
      anchor: { relativeTo: "front", dxFrac: 0, dyFrac: 0.1 }
    }
  }
};

/**
 * Measured 2026-07-02 by rendering per-placement calibration grids through
 * Printful's Mockup Generator (out/calibration/*). Grid numbers read
 * unmirrored on every piece, so no orientation flips are applied.
 */
const PROFILES: Record<number, CalibrationProfile> = {
  // All-Over Print Recycled Unisex Hoodie — every placement is a 40x40" canvas.
  388: {
    front: { pieceWFrac: 0.64, pieceHFrac: 0.78, pieceCxFrac: 0.5, pieceCyFrac: 0.54 },
    back: { pieceWFrac: 0.64, pieceHFrac: 0.86, pieceCxFrac: 0.5, pieceCyFrac: 0.51 },
    sleeve_left: { pieceWFrac: 0.52, pieceHFrac: 0.56, pieceCxFrac: 0.5, pieceCyFrac: 0.5 },
    sleeve_right: { pieceWFrac: 0.52, pieceHFrac: 0.56, pieceCxFrac: 0.5, pieceCyFrac: 0.5 },
    hood: { pieceWFrac: 0.55, pieceHFrac: 0.34, pieceCxFrac: 0.45, pieceCyFrac: 0.78 },
    // Pouch pocket: piece occupies the lower-center of its canvas; its art
    // must continue the front art 3.2" below the front piece center.
    pocket: {
      pieceWFrac: 0.31,
      pieceHFrac: 0.2,
      pieceCxFrac: 0.5,
      pieceCyFrac: 0.575,
      anchor: { relativeTo: "front", dxFrac: 0, dyFrac: 0.08 }
    }
  },
  // All-Over Print Men's Crew Neck T-Shirt — body 28x36", sleeves 20x12".
  257: {
    default: { pieceWFrac: 0.66, pieceHFrac: 0.8, pieceCxFrac: 0.5, pieceCyFrac: 0.55 },
    back: { pieceWFrac: 0.66, pieceHFrac: 0.8, pieceCxFrac: 0.5, pieceCyFrac: 0.55 },
    sleeve_left: { pieceWFrac: 0.7, pieceHFrac: 0.55, pieceCxFrac: 0.5, pieceCyFrac: 0.655 },
    sleeve_right: { pieceWFrac: 0.7, pieceHFrac: 0.55, pieceCxFrac: 0.5, pieceCyFrac: 0.655 }
  },
  // All-Over Print Yoga Leggings — default canvas 47x41" holds BOTH legs
  // side by side sharing the center inseam; belts are separate strips.
  242: {
    default: { pieceWFrac: 0.56, pieceHFrac: 0.92, pieceCxFrac: 0.5, pieceCyFrac: 0.5 },
    belt_front: { pieceWFrac: 0.6, pieceHFrac: 0.5, pieceCxFrac: 0.5, pieceCyFrac: 0.6 },
    belt_back: { pieceWFrac: 0.6, pieceHFrac: 0.5, pieceCxFrac: 0.5, pieceCyFrac: 0.6 }
  }
};

export const registerCalibrationProfile = (productId: number, profile: CalibrationProfile) => {
  PROFILES[productId] = profile;
};

export const getCalibrationProfile = (
  productId: number | string | null | undefined
): CalibrationProfile | undefined => {
  const id = typeof productId === "string" ? Number(productId) : productId;
  if (!id || !Number.isFinite(id)) return undefined;
  const base = CATALOG_PROFILES[String(id)] ?? PROFILES[id];
  const overrides = EMPIRICAL_OVERRIDES[id];
  if (!base) return overrides;
  if (!overrides) return base;
  return { ...base, ...overrides };
};
