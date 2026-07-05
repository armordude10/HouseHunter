/**
 * Print-area geometry math. Pure (numbers only), so it is unit-testable and shared
 * identically by the preview compositor and the order payload.
 */

import type { PlacementGeometry, PrintPosition } from "../providers/types.js";

/**
 * Contain-fit a piece of art into the printable area, centered.
 *
 * We define the design's coordinate space to equal the print-area pixel space
 * (area_width/height = print-area width/height). That keeps the preview mapping
 * 1:1 and means the exact same `position` we render is the one we submit to the
 * provider — the provider re-scales that area onto the physical print area.
 */
export function fitArtToPrintArea(
  artWidth: number,
  artHeight: number,
  areaWidth: number,
  areaHeight: number
): PrintPosition {
  const scale = Math.min(areaWidth / artWidth, areaHeight / artHeight);
  const width = Math.round(artWidth * scale);
  const height = Math.round(artHeight * scale);
  const left = Math.round((areaWidth - width) / 2);
  const top = Math.round((areaHeight - height) / 2);
  return { area_width: areaWidth, area_height: areaHeight, width, height, top, left };
}

/** All-over / cut-sew: the art fills the entire print area (edge to edge). */
export function fillPrintArea(areaWidth: number, areaHeight: number): PrintPosition {
  return { area_width: areaWidth, area_height: areaHeight, width: areaWidth, height: areaHeight, top: 0, left: 0 };
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map a printfile-space `position` onto the actual base mockup image in pixels.
 *
 *   printfile space (position.area_*) --rx/ry--> print area on template
 *                                      --sx/sy--> actual base image resolution
 */
export function artRectInBaseImage(
  position: PrintPosition,
  geometry: PlacementGeometry,
  baseImageWidth: number,
  baseImageHeight: number
): PixelRect {
  const rx = geometry.printAreaWidth / position.area_width;
  const ry = geometry.printAreaHeight / position.area_height;
  const sx = geometry.templateWidth > 0 ? baseImageWidth / geometry.templateWidth : 1;
  const sy = geometry.templateHeight > 0 ? baseImageHeight / geometry.templateHeight : 1;

  return {
    left: Math.round((geometry.printAreaLeft + position.left * rx) * sx),
    top: Math.round((geometry.printAreaTop + position.top * ry) * sy),
    width: Math.max(1, Math.round(position.width * rx * sx)),
    height: Math.max(1, Math.round(position.height * ry * sy)),
  };
}
