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
  /** Physical size in inches (target / dpi). */
  widthIn: number;
  heightIn: number;
  /** Position on the garment plane, inches, origin top-left. */
  xIn: number;
  yIn: number;
  /** Whether this panel participates in seam-bound master slicing. */
  seamBound: boolean;
}

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

const resolvePanelSize = (input: PanelGeometryInput) => {
  const dpi = num(input.dpi) ?? DEFAULT_DPI;
  const widthPx = num(input.width_px) ?? Math.round(DEFAULT_WIDTH_IN * dpi);
  const heightPx = num(input.height_px) ?? Math.round(DEFAULT_HEIGHT_IN * dpi);
  return {
    dpi,
    targetWidthPx: Math.round(widthPx),
    targetHeightPx: Math.round(heightPx),
    widthIn: widthPx / dpi,
    heightIn: heightPx / dpi
  };
};

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
export const buildGarmentPlane = (inputs: PanelGeometryInput[]): GarmentPlane => {
  const sized = inputs.map((input) => ({
    input,
    role: classifyPlacement(input.placement),
    ...resolvePanelSize(input)
  }));

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
  let cursorX = 0;
  let previous: (typeof row)[number] | null = null;
  for (const panel of row) {
    panels.push({
      placement: panel.input.placement,
      role: panel.role,
      targetWidthPx: panel.targetWidthPx,
      targetHeightPx: panel.targetHeightPx,
      dpi: panel.dpi,
      widthIn: panel.widthIn,
      heightIn: panel.heightIn,
      xIn: cursorX,
      yIn: hoodHeight,
      seamBound: row.length > 1
    });
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
    panels.push({
      placement: hood.input.placement,
      role: "hood",
      targetWidthPx: hood.targetWidthPx,
      targetHeightPx: hood.targetHeightPx,
      dpi: hood.dpi,
      widthIn: hood.widthIn,
      heightIn: hood.heightIn,
      xIn: Math.max(0, hoodX),
      yIn: 0,
      seamBound: row.length > 0
    });
    if (bodyAnchor) {
      seams.push({
        a: hood.input.placement,
        b: bodyAnchor.placement,
        edge: "horizontal",
        atIn: hoodHeight
      });
    }
  }

  // AOP pouch-pocket continuity: providers like Printful give the pocket the
  // SAME print canvas as the front and mask the pocket shape from it, so an
  // identical crop makes the pocket invisible against the front art. When
  // the pocket canvas matches the front canvas, pin its rect to the front's.
  if (pocket) {
    const front = panels.find((panel) => panel.role === "front");
    const sameCanvas =
      front &&
      Math.abs(front.widthIn - pocket.widthIn) < 0.01 &&
      Math.abs(front.heightIn - pocket.heightIn) < 0.01;
    panels.push({
      placement: pocket.input.placement,
      role: "pocket",
      targetWidthPx: pocket.targetWidthPx,
      targetHeightPx: pocket.targetHeightPx,
      dpi: pocket.dpi,
      widthIn: pocket.widthIn,
      heightIn: pocket.heightIn,
      xIn: sameCanvas
        ? front.xIn
        : front
          ? front.xIn + (front.widthIn - pocket.widthIn) / 2
          : 0,
      yIn: sameCanvas
        ? front.yIn
        : front
          ? front.yIn + front.heightIn - pocket.heightIn
          : hoodHeight + rowHeight + 1,
      seamBound: Boolean(front)
    });
  }

  let detachedX = 0;
  const detachedY = hoodHeight + rowHeight + 1;
  let detachedRowHeight = 0;
  for (const panel of detachedPanels) {
    panels.push({
      placement: panel.input.placement,
      role: panel.role,
      targetWidthPx: panel.targetWidthPx,
      targetHeightPx: panel.targetHeightPx,
      dpi: panel.dpi,
      widthIn: panel.widthIn,
      heightIn: panel.heightIn,
      xIn: detachedX,
      yIn: detachedY,
      seamBound: false
    });
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
