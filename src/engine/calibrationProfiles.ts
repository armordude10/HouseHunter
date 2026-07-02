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

import { CalibrationProfile } from "./garmentSpace.js";

const PROFILES: Record<number, CalibrationProfile> = {};

export const registerCalibrationProfile = (productId: number, profile: CalibrationProfile) => {
  PROFILES[productId] = profile;
};

export const getCalibrationProfile = (
  productId: number | string | null | undefined
): CalibrationProfile | undefined => {
  const id = typeof productId === "string" ? Number(productId) : productId;
  return id && Number.isFinite(id) ? PROFILES[id] : undefined;
};
