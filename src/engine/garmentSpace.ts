/**
 * Garment-space compiler.
 *
 * The core idea behind deterministic multi-panel continuity: every panel of a
 * product (front, back, sleeves, hood, pocket, labels...) is mapped into ONE
 * shared 2D coordinate system — the "unwrapped garment plane", measured in
 * inches. Artwork is authored once against that plane (a master composition
 * or a seamless tile), and each panel file is *cut* from it with exact pixel
 * math. Panels that share a physical seam are laid out sharing a cut line, so
 * their art continues across the seam BY CONSTRUCTION — no generative model
 * is ever asked to "make it seamless".
 *
 * The layout is fully data-driven from the surface plan's placement jobs: a
 * Gildan 5000 (front only) produces a one-rect plane; an AOP crew neck
 * (front, back, left_sleeve, right_sleeve) produces a wrap row with sleeve
 * panels flanking the body panels; unknown placements degrade gracefully to a
 * detached second row (accounted, rendered, but not seam-bound).
 */

export interface PanelGeometryInput {
  placement: string;
  width_px?: number | null;
  height_px?: number | null;
  dpi?: number | null;
}

export type PanelRole =
  | "front"
  | "back"
  | "left_sleeve"
  | "right_sleeve"
  | "left_leg"
  | "right_leg"
  | "hood"
  | "pocket"
  | "neck"
  | "label"
  | "detached";

export interface PanelPlan {
  placement: string;
  role: PanelRole;
  /** Final print-file target in pixels. */
  targetWidthPx: number;
  targetHeightPx: number;
  dpi: number;
  /**
   * VISIBLE PIECE size in inches — the region of the file canvas that ends
   * up on the sewn piece (from the product's calibration profile; equals the
   * full canvas when uncalibrated).
   */
  widthIn: number;
  heightIn: number;
  /** Piece position on the garment plane, inches, origin top-left. */
  xIn: number;
  yIn: number;
  /**
   * FILE CANVAS window on the plane, inches. This is what gets cropped and
   * submitted: the canvas is positioned so its piece region lands exactly at
   * (xIn,yIn) — canvas margins then automatically carry the neighboring
   * plane art, which is what provides seam allowance / bleed continuity.
   */
  canvasXIn: number;
  canvasYIn: number;
  canvasWIn: number;
  canvasHIn: number;
  /** Whether this panel participates in seam-bound master slicing. */
  seamBound: boolean;
}

/**
 * Per-product calibration: where the visible sewn piece sits within each
 * placement's file canvas, measured by rendering labeled calibration grids
 * through the provider's real mockup generator (scripts/calibrate.ts).
 * Fractions are relative to the canvas (0..1).
 */
export interface PlacementCalibration {
  /** Piece width/height as a fraction of the canvas. */
  pieceWFrac: number;
  pieceHFrac: number;
  /** Piece CENTER position within the canvas, as fractions. */
  pieceCxFrac: number;
  pieceCyFrac: number;
  /**
   * Optional anatomical anchor: piece-center offset from another placement's
   * piece center, as fractions of THIS placement's canvas — e.g. a hoodie
   * pouch pocket anchored to the front so its art continues the surrounding
   * front art.
   */
  anchor?: { relativeTo: string; dxFrac: number; dyFrac: number };
}

export type CalibrationProfile = Record<string, PlacementCalibration>;

export interface SeamBond {
  a: string;
  b: string;
  /** Shared cut line: "a's <edge> meets b's <opposite edge>". */
  edge: "vertical" | "horizontal";
  /** X (vertical) or Y (horizontal) coordinate of the shared line, inches. */
  atIn: number;
}

export interface GarmentPlane {
  panels: PanelPlan[];
  seams: SeamBond[];
  widthIn: number;
  heightIn: number;
}

const DEFAULT_DPI = 150;
/** Default print-area guess when geometry truth is unavailable: 12"x16". */
const DEFAULT_WIDTH_IN = 12;
const DEFAULT_HEIGHT_IN = 16;

const num = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const classifyPlacement = (placement: string): PanelRole => {
  const name = placement.toLowerCase();
  if (/label/.test(name)) return "label";
  if (/neck/.test(name)) return "neck";
  if (/hood/.test(name)) return "hood";
  if (/pocket/.test(name)) return "pocket";
  // Waistband/collar/cuff strips are separate physical pieces; never body panels.
  if (/belt|waist|cuff|collar|bottom|top\b/.test(name)) return "detached";
  if (/leg\b|_leg|leg_/.test(name)) return /right/.test(name) ? "right_leg" : "left_leg";
  if (/(left|l)[_\- ]?sleeve|sleeve[_\- ]?(left|l)\b/.test(name)) return "left_sleeve";
  if (/(right|r)[_\- ]?sleeve|sleeve[_\- ]?(right|r)\b/.test(name)) return "right_sleeve";
  if (/back/.test(name)) return "back";
  if (/front|chest|default/.test(name)) return "front";
  return "detached";
};

/** Clamp a calibration fraction into a sane range; fall back on garbage. */
const frac = (value: unknown, fallback: number, min = 0.02, max = 1): number => {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
};

const resolvePanelSize = (input: PanelGeometryInput, cal?: PlacementCalibration) => {
  const dpi = num(input.dpi) ?? DEFAULT_DPI;
  const widthPx = num(input.width_px) ?? Math.round(DEFAULT_WIDTH_IN * dpi);
  const heightPx = num(input.height_px) ?? Math.round(DEFAULT_HEIGHT_IN * dpi);
  // Physical canvas bounded to sane garment scale (corrupt contracts clamp).
  const canvasWIn = Math.min(120, Math.max(0.25, widthPx / dpi));
  const canvasHIn = Math.min(120, Math.max(0.25, heightPx / dpi));
  return {
    dpi,
    targetWidthPx: Math.round(widthPx),
    targetHeightPx: Math.round(heightPx),
    canvasWIn,
    canvasHIn,
    widthIn: canvasWIn * frac(cal?.pieceWFrac, 1),
    heightIn: canvasHIn * frac(cal?.pieceHFrac, 1),
    cxFrac: frac(cal?.pieceCxFrac, 0.5, 0, 1),
    cyFrac: frac(cal?.pieceCyFrac, 0.5, 0, 1),
    anchor: cal?.anchor
  };
};

/** Canvas window placed so the piece region lands at the piece plane rect. */
const canvasWindow = (panel: {
  xIn: number;
  yIn: number;
  widthIn: number;
  heightIn: number;
  canvasWIn: number;
  canvasHIn: number;
  cxFrac: number;
  cyFrac: number;
}) => ({
  canvasXIn: panel.xIn + panel.widthIn / 2 - panel.cxFrac * panel.canvasWIn,
  canvasYIn: panel.yIn + panel.heightIn / 2 - panel.cyFrac * panel.canvasHIn,
  canvasWIn: panel.canvasWIn,
  canvasHIn: panel.canvasHIn
});

/**
 * Build the garment plane for an arbitrary set of placements.
 *
 * Seam-bound layout (single row, shared vertical cut lines, tops aligned at
 * the shoulder line):
 *
 *   [left_sleeve][back][front][right_sleeve]
 *
 * This mirrors how a knit garment physically wraps: back meets front at the
 * wearer's left side seam as you travel around the body, and each sleeve
 * continues outward from the adjacent body panel. A hood sits above the row
 * (horizontal seam to the body top). Pocket/neck/label/unknown panels are
 * detached: they get real positions on a second row for deterministic
 * accounting, but art for them is derived per-panel, not sliced.
 */
export const buildGarmentPlane = (
  inputs: PanelGeometryInput[],
  profile?: CalibrationProfile
): GarmentPlane => {
  const sized = inputs.map((input) => ({
    input,
    role: classifyPlacement(input.placement),
    ...resolvePanelSize(input, profile?.[input.placement])
  }));

  const push = (
    panel: (typeof sized)[number],
    xIn: number,
    yIn: number,
    seamBound: boolean,
    panels: PanelPlan[]
  ) => {
    panels.push({
      placement: panel.input.placement,
      role: panel.role,
      targetWidthPx: panel.targetWidthPx,
      targetHeightPx: panel.targetHeightPx,
      dpi: panel.dpi,
      widthIn: panel.widthIn,
      heightIn: panel.heightIn,
      xIn,
      yIn,
      ...canvasWindow({ ...panel, xIn, yIn }),
      seamBound
    });
  };

  // Legs behave like body panels: on leggings the two leg panels meet at the
  // center-front/center-back seams, so they share a cut line on the plane.
  const rowOrder: PanelRole[] = [
    "left_sleeve",
    "back",
    "front",
    "right_sleeve",
    "left_leg",
    "right_leg"
  ];
  const row = rowOrder
    .map((role) => sized.find((panel) => panel.role === role))
    .filter((panel): panel is NonNullable<typeof panel> => Boolean(panel));
  const hood = sized.find((panel) => panel.role === "hood");
  const pocket = sized.find((panel) => panel.role === "pocket");
  const detachedPanels = sized.filter(
    (panel) => !row.includes(panel as never) && panel !== hood && panel !== pocket
  );

  const panels: PanelPlan[] = [];
  const seams: SeamBond[] = [];

  const hoodHeight = hood ? hood.heightIn : 0;
  // A single body panel is still master-sliced when overlay/attached pieces
  // (pocket, hood) must continue its art — e.g. backpack front + pocket.
  const bodySeamBound = row.length > 1 || Boolean(pocket) || Boolean(hood);
  // SLEEVE DROP: on a sewn garment the sleeve cap joins the armhole BELOW
  // the shoulder line — the underarm points are what physically meet. Align
  // them instead of the panel tops: armhole depth ~28% of body height on the
  // body side, cap height ~17% of sleeve length on the sleeve side. This puts
  // horizontal features (horizons, stripes, waterlines) at the same WORN
  // height across the body->sleeve seam.
  const bodyHeightIn = Math.max(
    0,
    ...row.filter((p) => p.role === "front" || p.role === "back").map((p) => p.heightIn)
  );
  const sleeveDrop = (panel: (typeof row)[number]): number =>
    (panel.role === "left_sleeve" || panel.role === "right_sleeve") && bodyHeightIn > 0
      ? Math.max(0, 0.28 * bodyHeightIn - 0.17 * panel.heightIn)
      : 0;
  let cursorX = 0;
  let previous: (typeof row)[number] | null = null;
  for (const panel of row) {
    push(panel, cursorX, hoodHeight + sleeveDrop(panel), bodySeamBound, panels);
    if (previous) {
      seams.push({
        a: previous.input.placement,
        b: panel.input.placement,
        edge: "vertical",
        atIn: cursorX
      });
    }
    previous = panel;
    cursorX += panel.widthIn;
  }
  const rowWidth = cursorX;
  const rowHeight = Math.max(0, ...row.map((panel) => panel.heightIn));

  if (hood) {
    const bodyAnchor =
      panels.find((panel) => panel.role === "back") ??
      panels.find((panel) => panel.role === "front");
    const hoodX = bodyAnchor
      ? bodyAnchor.xIn + (bodyAnchor.widthIn - hood.widthIn) / 2
      : Math.max(0, (rowWidth - hood.widthIn) / 2);
    push(hood, Math.max(0, hoodX), 0, row.length > 0, panels);
    if (bodyAnchor) {
      seams.push({
        a: hood.input.placement,
        b: bodyAnchor.placement,
        edge: "horizontal",
        atIn: hoodHeight
      });
    }
  }

  // Pouch-pocket continuity: the pocket piece sits ON the front piece, so
  // its plane position must make its art continue the surrounding front art.
  // A calibrated anchor gives the measured offset from the front piece
  // center; without calibration, default to lower-center of the front.
  if (pocket) {
    const front = panels.find((panel) => panel.role === "front");
    if (front) {
      const anchor = pocket.anchor;
      const anchored = anchor?.relativeTo === front.placement;
      const cx =
        front.xIn + front.widthIn / 2 + (anchored ? anchor.dxFrac * pocket.canvasWIn : 0);
      // Default pouch position measured empirically on Printful AOP hoodies
      // (pocket-truth calibration): pocket center ≈ 61% down the front piece.
      const cy = anchored
        ? front.yIn + front.heightIn / 2 + anchor.dyFrac * pocket.canvasHIn
        : front.yIn + front.heightIn * 0.61;
      push(pocket, cx - pocket.widthIn / 2, cy - pocket.heightIn / 2, true, panels);
    } else {
      push(pocket, 0, hoodHeight + rowHeight + 1, false, panels);
    }
  }

  let detachedX = 0;
  const detachedY = hoodHeight + rowHeight + 1;
  let detachedRowHeight = 0;
  for (const panel of detachedPanels) {
    push(panel, detachedX, detachedY, false, panels);
    detachedX += panel.widthIn + 1;
    detachedRowHeight = Math.max(detachedRowHeight, panel.heightIn);
  }

  const widthIn = Math.max(rowWidth, detachedX, hood ? hood.widthIn : 0, 1);
  const heightIn = Math.max(
    hoodHeight + rowHeight + (detachedPanels.length ? 1 + detachedRowHeight : 0),
    1
  );

  return { panels, seams, widthIn, heightIn };
};

/** Panels that slice from the shared master canvas. */
export const seamBoundPanels = (plane: GarmentPlane): PanelPlan[] =>
  plane.panels.filter((panel) => panel.seamBound);
