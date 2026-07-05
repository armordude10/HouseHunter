/**
 * Express-path surface planning: a pure function from (product, Printful
 * placement truth, intent) to Panel Compiler jobs. No LLM involvement.
 *
 * The margin rules of print-on-demand are encoded here rather than left to
 * a model's judgment:
 *   - AOP/sublimation products include every panel in the base price, so
 *     full coverage is free -> plan ALL renderable placements.
 *   - DTG products charge per extra placement, so the default plan is the
 *     primary placement only; extra DTG placements would eat the margin.
 *   - label placements (inside/outside brand labels) are never auto-filled.
 */

import { CompileJob } from "../engine/panelCompiler.js";
import { ExpressIntent } from "./intent.js";
import { ExpressProduct } from "./catalog.js";
import { PlacementSpec } from "./truth.js";

const isLabelPlacement = (placement: string) => /label/i.test(placement);

export const pickPrimaryPlacement = (specs: PlacementSpec[]): PlacementSpec => {
  return (
    specs.find((spec) => spec.placement === "front") ??
    specs.find((spec) => spec.placement === "default") ??
    specs[0]
  );
};

export const buildExpressJobs = (
  product: ExpressProduct,
  specs: PlacementSpec[],
  intent: ExpressIntent
): { jobs: CompileJob[]; activeSpecs: PlacementSpec[] } => {
  let renderable = specs.filter((spec) => !isLabelPlacement(spec.placement));
  if (!renderable.length) {
    throw new Error(`product ${product.productId} has no renderable placements`);
  }

  // Placement semantics differ by technique family: cut-sew placements are
  // sewn PANELS (additive — front+back+sleeves), but sublimation products
  // that expose a "default" placement (mugs, posters, blankets) list the
  // others as ALTERNATIVE print modes of the same surface. Planning "all"
  // there would double-print one surface; "default" IS the full coverage.
  const defaultSpec = renderable.find((spec) => spec.placement === "default");
  if (defaultSpec && !renderable.some((spec) => spec.technique === "cut-sew")) {
    renderable = [defaultSpec];
  }

  const fullCoverage = product.aop && intent.coverage === "full";
  const activeSpecs = fullCoverage ? renderable : [pickPrimaryPlacement(renderable)];

  const multiPanel = activeSpecs.length > 1;
  const action = intent.wants_repeat_pattern
    ? "repeat_pattern"
    : multiPanel
      ? "slice_from_master"
      : "generate";

  const jobs = activeSpecs.map((spec) => ({
    job_id: `express_${spec.placement}`,
    placement: spec.placement,
    design_action: action,
    must_generate: true,
    must_render_in_mockup: true,
    geometry_contract: {
      width_px: Math.round(spec.widthIn * spec.dpi),
      height_px: Math.round(spec.heightIn * spec.dpi),
      dpi: spec.dpi
    }
  }));

  return { jobs, activeSpecs };
};

/**
 * Deterministic stitch color for cut-sew products that require it: light
 * designs get white seams, everything else black. (The agent pipeline's
 * Options Resolver does this with a model; at express tier a palette scan
 * is indistinguishable in outcome and free.)
 */
export const pickStitchColor = (intent: ExpressIntent): "black" | "white" => {
  const lightWords = /white|cream|ivory|pastel|light|pale|blush|beige/i;
  const lightVotes = intent.palette.filter((color) => lightWords.test(color)).length;
  return intent.palette.length && lightVotes >= Math.ceil(intent.palette.length / 2)
    ? "white"
    : "black";
};
