/**
 * PHASE 1 — Preview. Selects a product from the full catalog, discovers ALL its
 * panels, generates art that fits each panel, and renders a REAL multi-panel
 * provider mockup. A cut-sew jersey gets front/back/sleeves/yoke designed — not a
 * single front file with blank sleeves.
 */

import { randomUUID } from "node:crypto";
import type { FulfillmentProvider, Placement, PrintPosition, ResolvedVariant } from "../providers/types.js";
import type { Brain, CatalogProduct, TextPlacement } from "./ai.js";
import { fetchBuffer, imageSize } from "./composite.js";
import { DesignSpecSchema, type DesignSpec } from "./designSpec.js";
import { computeOrderHash, sha256Hex } from "./hash.js";
import { fillPrintArea, fitArtToPrintArea } from "./position.js";
import { cutoutBackground } from "./cutout.js";
import { pickGarmentColor } from "./garmentColor.js";
import type { CatalogRetriever } from "./retriever.js";
import type { ImageStore, SpecStore } from "./store.js";
import {
  classifyMode,
  makeSeamless,
  panelScale,
  selectDesignPanels,
  sliceSceneToPanels,
  tileFill,
  type Panel,
} from "./surface.js";
import { getOrBuildProfile } from "./productProfile.js";

export interface PreviewDeps {
  brain: Brain;
  provider: FulfillmentProvider;
  specs: SpecStore;
  images: ImageStore;
  retriever: CatalogRetriever;
  providerName: string;
}

export interface PreviewRequest {
  prompt: string;
  imageUrls?: string[];
  defaultSize?: string;
}

export interface PreviewResult {
  status: "ready" | "blocked" | "failed";
  designId?: string;
  previewImageUrl?: string;
  product?: string;
  color?: string;
  panels?: string[];
  message?: string;
}

// Single locked product (Gildan 5000). Resolved once from the live Printful catalog and cached.
let _lockedCatalog: CatalogProduct[] | null = null;
async function lockedCatalog(provider: FulfillmentProvider): Promise<CatalogProduct[]> {
  if (_lockedCatalog) return _lockedCatalog;
  const found = await provider.findCatalogProduct("gildan 5000");
  if (!found) return [];
  _lockedCatalog = [
    {
      id: `pf-${found.id}`,
      name: found.name,
      keywords: ["shirt", "tee", "t-shirt", "gildan", "5000"],
      defaultColor: "",
      default: true,
      technique: "",
      primaryPlacement: "front",
      providers: { printful: { productId: found.id } },
    },
  ];
  return _lockedCatalog;
}

const _colorCache = new Map<string, Array<{ name: string; hex: string }>>();
async function getProductColors(provider: FulfillmentProvider, productId: number | string) {
  const key = String(productId);
  const hit = _colorCache.get(key);
  if (hit) return hit;
  const colors = await provider.getColors(productId);
  _colorCache.set(key, colors);
  return colors;
}

type Understanding = Awaited<ReturnType<Brain["understandAndSelect"]>>;

interface PreviewContext {
  understanding: Understanding;
  picked: Producible;
}

/** Understand the request and resolve the producible product ONCE, so the result is shared
 * across every variation render. A single "Generate" tap therefore costs ONE gpt-4o call — not
 * one per variation — and resolves the product against the provider only once. */
async function understand(
  deps: PreviewDeps,
  req: PreviewRequest
): Promise<{ ok: true; ctx: PreviewContext } | { ok: false; result: PreviewResult }> {
  // Locked to a single product (Gildan 5000 tee): no product selection. Its real catalog id is
  // resolved from Printful once and cached, so we never hardcode or guess it.
  const candidates = await lockedCatalog(deps.provider);
  if (!candidates.length)
    return { ok: false, result: { status: "failed", message: "Couldn't resolve the Gildan 5000 product from the catalog." } };
  const understanding = await deps.brain.understandAndSelect({
    prompt: req.prompt,
    imageUrls: req.imageUrls,
    catalog: candidates,
    defaultSize: req.defaultSize,
  });
  if (understanding.policy.status === "block")
    return { ok: false, result: { status: "blocked", message: understanding.policy.reason ?? "Request can't be fulfilled." } };
  const picked = await pickProducible(deps, candidates, understanding);
  if (!picked)
    return { ok: false, result: { status: "failed", message: "Couldn't resolve a producible product for this request." } };
  return { ok: true, ctx: { understanding, picked } };
}

/** Render ONE design from a shared understanding: generate the artwork, fit it to each panel,
 * and render a real provider mockup. Called N times per tap to produce N variations cheaply. */
async function renderOne(deps: PreviewDeps, req: PreviewRequest, ctx: PreviewContext): Promise<PreviewResult> {
  const { understanding, picked } = ctx;
  const { product, providerProductId, technique, panels } = picked;
  let variant = picked.variant;

  const mode = classifyMode(technique);
  const designP = selectDesignPanels(panels, mode);
  if (!designP.length) return { status: "failed", message: "Product exposes no design panels." };

  const allOver = mode === "all_over";
  // All-over panels must fill their REAL print area: fetch each panel's v2 print-area (px) and
  // use it as the panel's working dimensions, so the generated art shape + position match and fill.
  const v2areas = allOver
    ? await deps.provider.getPrintAreasV2(providerProductId, designP.map((p) => p.placement))
    : new Map<string, { width: number; height: number }>();
  const effP = designP.map((p) => {
    const a = v2areas.get(p.placement);
    return a && a.width > 0 && a.height > 0 ? { ...p, width: a.width, height: a.height } : p;
  });
  const id = randomUUID();
  // DTG/graphic: a full-colour graphic fused from the customer's text/image on a transparent,
  // soft-edged background (no box). All-over: a full-bleed design.
  const master = await deps.brain.generateArtwork(understanding.artworkBrief, {
    imageUrls: req.imageUrls,
    transparent: !allOver,
  });
  // Graphic (DTG): guarantee no background box + soft edges no matter what the model returned —
  // flood-fill the border background to transparent, feather, and crop to the design so it scales
  // to fill the print area instead of sitting tiny in a corner.
  if (!allOver) {
    master.buffer = await cutoutBackground(master.buffer);
    master.mime = "image/png";
  }
  const masterDims = await imageSize(master.buffer);

  const placements: Placement[] = [];
  const mockupFiles: Array<{ placement: string; fileUrl: string; position: PrintPosition; dpi?: number }> = [];

  // All-over: a seamless repeating pattern, OR a single scene sliced across panels.
  const scale = allOver ? panelScale(effP) : 1;
  const sceneMode = allOver && understanding.designStyle === "scene";
  const seamless = allOver && !sceneMode ? await makeSeamless(master.buffer) : null;
  const sliceMap = sceneMode ? await sliceSceneToPanels(master.buffer, effP, scale) : null;

  // Per panel: build the panel art, then run a focused second pass (in parallel
  // across panels) to add any requested text onto exactly the panel it belongs
  // to — without changing the art or aspect ratio — before hosting the file.
  const panelOut = await Promise.all(
    effP.map(async (panel) => {
      let buf: Buffer;
      let mime: string;
      let position: PrintPosition;
      let options: Awaited<ReturnType<typeof deps.provider.resolveDecorationOptions>> = [];

      if (allOver) {
        buf = sliceMap ? sliceMap.get(panel.placement)! : await tileFill(seamless!, panel, scale);
        mime = "image/jpeg";
        position = fillPrintArea(panel.width, panel.height);
      } else {
        // Graphic placement: center + scale the design within the panel's REAL print area,
        // measured in the printfile's own pixel space (panel.width/height at panel.dpi) so the
        // mockup's px->inch conversion lands it centered and full size — not tiny in a corner.
        position = fitArtToPrintArea(masterDims.width, masterDims.height, panel.width, panel.height);
        buf = master.buffer;
        mime = master.mime;
      }

      const textItems = textForPanel(understanding.textPlacements, panel.placement, allOver);
      if (textItems.length) {
        try {
          const texted = await deps.brain.addText(buf, textItems, prettyPanel(panel.placement), !allOver);
          buf = texted.buffer;
          mime = texted.mime;
          // The text edit can re-introduce a background; re-assert the cutout (no re-crop so the
          // already-computed position stays aligned).
          if (!allOver) { buf = await cutoutBackground(buf, { trim: false }); mime = "image/png"; }
        } catch (err) {
          console.error(`[preview] text pass failed on ${panel.placement}:`, err);
        }
      }

      const ext = mime === "image/png" ? "png" : "jpg";
      const sha = sha256Hex(buf);
      const fileUrl = await deps.images.put(buf, `art-${sha.slice(0, 16)}.${ext}`, mime);
      if (!allOver) options = await deps.provider.resolveDecorationOptions(panel.placement, technique, fileUrl);
      return { placement: panel.placement, fileUrl, sha, position, options, dpi: panel.dpi };
    })
  );

  for (const p of panelOut) {
    placements.push({ name: p.placement, technique, fileUrl: p.fileUrl, fileSha256: p.sha, position: p.position, options: p.options, mustRender: true });
    mockupFiles.push({ placement: p.placement, fileUrl: p.fileUrl, position: p.position, dpi: p.dpi });
  }

  // Intelligent garment colour: with no colour specified, choose the shirt that best pairs with
  // the finished design — strong contrast for legibility plus colour-wheel harmony.
  if (!understanding.color && !allOver) {
    try {
      const colors = await getProductColors(deps.provider, providerProductId);
      const pick = await pickGarmentColor(master.buffer, colors);
      if (pick) variant = await deps.provider.resolveVariant(providerProductId, pick);
    } catch (err) {
      console.error(`[preview] garment colour pick failed:`, err);
    }
  }

  let previewImageUrl: string;
  try {
    previewImageUrl = await renderMockup(deps, id, providerProductId, variant.providerVariantId, technique, mockupFiles);
  } catch (err) {
    // Production stance: a failed mockup is a failure, not raw panel art dressed up as a preview.
    return { status: "failed", message: `Mockup render failed: ${(err as Error).message}` };
  }

  const color = variant.color || picked.color;
  const spec: DesignSpec = {
    id,
    createdAt: new Date().toISOString(),
    prompt: req.prompt,
    hasImageInput: !!(req.imageUrls && req.imageUrls.length),
    provider: deps.providerName,
    neutralProductId: product.id,
    providerBinding: { providerProductId, providerVariantId: variant.providerVariantId },
    color,
    size: understanding.size,
    placements,
    geometryVersion: `${deps.providerName}:printfiles:${new Date().toISOString().slice(0, 10)}`,
    previewImageUrl,
    policy: understanding.policy,
    orderHash: "",
  };
  spec.orderHash = computeOrderHash({
    provider: spec.provider,
    providerBinding: { providerProductId },
    color: spec.color,
    placements: spec.placements,
  });

  DesignSpecSchema.parse(spec);
  await deps.specs.save(spec);

  return {
    status: "ready",
    designId: id,
    previewImageUrl,
    product: product.name,
    color,
    panels: placements.map((p) => p.name),
  };
}

/** Single-design preview (the /preview endpoint): understand once, render once. */
export async function generatePreview(deps: PreviewDeps, req: PreviewRequest): Promise<PreviewResult> {
  const u = await understand(deps, req);
  if (!u.ok) return u.result;
  return renderOne(deps, req, u.ctx);
}

/** N variations for one tap (the /generate endpoint): understand ONCE, then fan out only the
 * image renders. This is the fix for the redundant per-variation gpt-5.5 calls. */
export async function generateVariationRenders(
  deps: PreviewDeps,
  req: PreviewRequest,
  count: number
): Promise<PreviewResult[]> {
  const u = await understand(deps, req);
  if (!u.ok) return [u.result];
  return Promise.all(
    Array.from({ length: Math.max(1, count) }, () =>
      renderOne(deps, req, u.ctx).catch((e): PreviewResult => ({
        status: "failed",
        message: String((e as Error)?.message ?? e),
      }))
    )
  );
}

/** Which requested texts belong on a given panel. Graphic products have a single
 * design panel, so all text lands there; all-over products route by area. */
function textForPanel(placements: TextPlacement[], panelPlacement: string, allOver: boolean): TextPlacement[] {
  if (!placements.length) return [];
  if (!allOver) return placements;
  return placements.filter((t) => areaMatchesPanel(t.area, panelPlacement));
}

function areaMatchesPanel(area: string, placement: string): boolean {
  const a = (area || "").toLowerCase();
  const p = (placement || "").toLowerCase();
  if (/back/.test(a)) return /back/.test(p);
  if (/left/.test(a)) return /left/.test(p) && /(sleeve|arm)/.test(p);
  if (/right/.test(a)) return /right/.test(p) && /(sleeve|arm)/.test(p);
  if (/front|chest/.test(a)) return /front/.test(p) || p === "default";
  return p.includes(a) || a.includes(p);
}

function prettyPanel(placement: string): string {
  const map: Record<string, string> = {
    sleeve_left: "left sleeve",
    sleeve_right: "right sleeve",
    left_sleeve: "left sleeve",
    right_sleeve: "right sleeve",
    front: "front",
    back: "back",
    default: "design",
  };
  return map[placement.toLowerCase()] ?? placement.replace(/[_-]+/g, " ");
}

interface Producible {
  product: CatalogProduct;
  providerProductId: number | string;
  variant: ResolvedVariant;
  technique: string;
  color: string;
  panels: Panel[];
}

async function pickProducible(
  deps: PreviewDeps,
  candidates: CatalogProduct[],
  understanding: { neutralProductId: string; color: string }
): Promise<Producible | null> {
  const chosenId = understanding.neutralProductId;
  const chosen = candidates.find((p) => p.id === chosenId);
  const ordered = chosen ? [chosen, ...candidates.filter((p) => p !== chosen)] : candidates;

  for (const product of ordered) {
    const prod = await tryProducible(deps, product, product.id === chosenId ? understanding.color : "");
    if (prod) return prod;
  }
  return null;
}

async function tryProducible(
  deps: PreviewDeps,
  product: CatalogProduct,
  wantColor: string
): Promise<Producible | null> {
  const providerProductId = product.providers[deps.providerName as "printful"]?.productId;
  if (providerProductId == null) return null;
  try {
    const truth = await deps.provider.getProductTruth(providerProductId);
    const color = wantColor || truth.defaultColor || "";
    const variant = await deps.provider.resolveVariant(providerProductId, color);
    // Per-variant profile: panels fetched from Printful ONCE and cached, so we never repeat a
    // retrieval and every product carries its real panel structure.
    const profile = await getOrBuildProfile(
      (pid, t, vid) => deps.provider.getPanels(pid, t, vid),
      providerProductId,
      variant.providerVariantId,
      truth.technique
    );
    if (!profile.panels.length) return null;
    return { product, providerProductId, variant, technique: truth.technique, color, panels: profile.panels };
  } catch {
    return null;
  }
}

/** Real provider mockup across all panels, re-hosted. Throws on failure — no fake fallback. */
async function renderMockup(
  deps: PreviewDeps,
  id: string,
  productId: number | string,
  variantId: number | string,
  technique: string,
  files: Array<{ placement: string; fileUrl: string; position: PrintPosition }>
): Promise<string> {
  const mockupUrl = await deps.provider.renderMockup({ productId, variantId, technique, files });
  const buf = await fetchBuffer(mockupUrl);
  return await deps.images.put(buf, `preview-${id}.jpg`, "image/jpeg");
}
