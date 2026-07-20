import { randomUUID } from "node:crypto";
import { getRunwareConfig } from "./runware-client.js";
import type { AgentTool } from "./tools.js";

/**
 * RUNWARE-BACKED ARTWORK TOOL
 *
 * The original workflow generated panel artwork through the
 * `threadbot_artwork_mcp` server's `generate_panel_artwork_bundle` tool. Per
 * the migration directive, artwork generation now runs on Runware image
 * models. We keep the exact tool NAME (`generate_panel_artwork_bundle`) so the
 * Placement Bundle Compiler's instructions remain valid and unchanged — only
 * the implementation changed: each panel is rendered with the best-fit Runware
 * image model and returned as a public PNG URL.
 *
 * Model selection (Runware AIR ids, June 2026 catalog):
 *   - recraft:v4.1-pro@0  → default for apparel graphics/logos with crisp
 *     edges and transparent backgrounds (Recraft is the strongest transparent
 *     PNG / brand-graphic model).
 *   - ideogram:4@0        → panels that must render legible text/typography
 *     (names, numbers, lettering, lockups).
 *   - bfl:5@1 (FLUX.2 pro)→ photoreal / complex hero illustration panels.
 */

const ARTWORK_MODELS = {
  graphic: "recraft:v4.1-pro@0",
  typography: "ideogram:4@0",
  hero: "bfl:5@1",
} as const;

const PANEL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    panels: {
      type: "array",
      description:
        "One entry per placement_job that needs a rendered raster (generate_unique_art, derive_from_master, slice_from_master, repeat_pattern, mirror_from_pair). Do not include leave_blank jobs.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          job_id: { type: "string", description: "placement_job.job_id this panel fulfills" },
          placement: { type: "string", description: "placement key, e.g. front, back, left_sleeve" },
          prompt: {
            type: "string",
            description: "Full positive artwork brief for this panel (subject, style, palette, composition).",
          },
          negative_prompt: { type: "string", description: "What to avoid in this panel." },
          worker_type: {
            type: "string",
            description:
              "master | hero | overlay | wrap | side | detail | embroidery | label | pattern",
          },
          width_px: { type: ["integer", "null"], description: "Target width if known from geometry." },
          height_px: { type: ["integer", "null"], description: "Target height if known from geometry." },
          transparent_background: {
            type: "boolean",
            description: "True for apparel art that must sit on the garment with no background.",
          },
          needs_text: {
            type: "boolean",
            description: "True if the panel must render legible text/typography.",
          },
        },
        required: ["placement", "prompt"],
      },
    },
  },
  required: ["panels"],
} as const;

interface PanelInput {
  job_id?: string;
  placement: string;
  prompt: string;
  negative_prompt?: string;
  worker_type?: string;
  width_px?: number | null;
  height_px?: number | null;
  transparent_background?: boolean;
  needs_text?: boolean;
}

interface PanelResult {
  job_id: string | null;
  placement: string;
  file_url: string | null;
  file_type: "png" | "none";
  public_url: boolean;
  transparent_background: boolean;
  model_used: string | null;
  width: number;
  height: number;
  status: "success" | "failed";
  notes: string;
}

export function buildArtworkTool(): AgentTool {
  return {
    name: "generate_panel_artwork_bundle",
    description:
      "Render panel artwork for placement jobs using Runware image models. Returns a public PNG URL per panel. " +
      "Selects Recraft V4.1 Pro for transparent apparel graphics/logos, Ideogram 4.0 for text-heavy panels, " +
      "and FLUX.2 Pro for photoreal/hero illustration. Call once with every non-blank placement job.",
    parameters: PANEL_INPUT_SCHEMA as unknown as Record<string, any>,
    invoke: async (args: Record<string, any>) => {
      const panels: PanelInput[] = Array.isArray(args?.panels) ? args.panels : [];
      if (panels.length === 0) {
        return JSON.stringify({
          ok: false,
          error: "no panels provided",
          panels: [],
        });
      }

      const results: PanelResult[] = [];
      for (const panel of panels) {
        results.push(await renderPanel(panel));
      }

      const allOk = results.every((r) => r.status === "success");
      return JSON.stringify({
        ok: allOk,
        provider: "runware",
        panels: results,
      });
    },
  };
}

function pickModel(panel: PanelInput): string {
  const wt = (panel.worker_type ?? "").toLowerCase();
  if (panel.needs_text || wt === "label" || wt === "embroidery") return ARTWORK_MODELS.typography;
  if (wt === "hero" || wt === "master") {
    // Hero/master art is high-value; FLUX.2 Pro unless it must be transparent
    // line/graphic art, in which case Recraft handles transparency better.
    return panel.transparent_background ? ARTWORK_MODELS.graphic : ARTWORK_MODELS.hero;
  }
  return ARTWORK_MODELS.graphic;
}

/** Clamp to a model-friendly size: within [256,1536] and a multiple of 64. */
function normalizeDimension(value: number | null | undefined, fallback: number): number {
  const v = typeof value === "number" && value > 0 ? value : fallback;
  const clamped = Math.min(1536, Math.max(256, Math.round(v)));
  return Math.round(clamped / 64) * 64;
}

async function renderPanel(panel: PanelInput): Promise<PanelResult> {
  const { apiKey, base } = getRunwareConfig();
  const model = pickModel(panel);
  const transparent = panel.transparent_background !== false; // default transparent for apparel art

  const positivePrompt = transparent
    ? `${panel.prompt}. Isolated artwork on a fully transparent background, no garment, no mockup, clean cut-out, print-ready.`
    : panel.prompt;

  // Build the base task. Image models on Runware differ in which optional
  // parameters they accept (Recraft rejects negativePrompt, some reject
  // transparentBackground, dimensions are model-specific), so we start lean and
  // self-heal from the API's own error feedback.
  const task: Record<string, any> = {
    taskType: "imageInference",
    taskUUID: randomUUID(),
    model,
    positivePrompt,
    width: normalizeDimension(panel.width_px, 1024),
    height: normalizeDimension(panel.height_px, 1024),
    numberResults: 1,
    outputType: "URL",
    outputFormat: "PNG",
    includeCost: true,
  };
  if (transparent) task.transparentBackground = true;

  let lastError = "no image URL returned";

  // Up to 5 attempts: each API error tells us exactly what to fix (drop an
  // unsupported parameter, or switch to an allowed dimension) and we retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify([task]),
    }).catch((e) => e as Error);

    if (res instanceof Error) {
      lastError = res.message;
      break;
    }

    const json: any = await res.json().catch(() => ({}));
    const err = Array.isArray(json?.errors) ? json.errors[0] : json?.error;

    if (!err) {
      const url = extractImageUrl(json);
      if (url) {
        return {
          job_id: panel.job_id ?? null,
          placement: panel.placement,
          file_url: url,
          file_type: "png",
          public_url: true,
          transparent_background: transparent,
          model_used: model,
          width: task.width,
          height: task.height,
          status: "success",
          notes: `rendered with ${model} at ${task.width}x${task.height}`,
        };
      }
      lastError = "no image URL returned";
      break;
    }

    lastError = err.message ?? `HTTP ${res.status}`;

    if (err.code === "unsupportedDimensions") {
      const chosen = pickAllowedDimension(err.allowedValues, task.width, task.height);
      if (chosen) {
        task.width = chosen.width;
        task.height = chosen.height;
        continue;
      }
    }

    // Drop whatever parameter the API rejected and retry.
    const bad = normalizeBadParams(err.parameter);
    let stripped = false;
    for (const p of bad) {
      if (p in task && !PROTECTED_PARAMS.has(p)) {
        delete task[p];
        stripped = true;
      }
    }
    if (stripped) continue;

    break; // unrecoverable error
  }

  return failPanel(panel, model, transparent, task.width, task.height, lastError);
}

const PROTECTED_PARAMS = new Set(["taskType", "taskUUID", "model", "positivePrompt", "numberResults"]);

function normalizeBadParams(parameter: unknown): string[] {
  if (Array.isArray(parameter)) return parameter.filter((p): p is string => typeof p === "string");
  if (typeof parameter === "string") return [parameter];
  return [];
}

/** Choose the allowed dimension whose aspect ratio is closest to the request. */
function pickAllowedDimension(
  allowed: Record<string, string> | undefined,
  width: number,
  height: number
): { width: number; height: number } | null {
  if (!allowed) return null;
  const target = width / height;
  let best: { width: number; height: number } | null = null;
  let bestDelta = Infinity;
  for (const value of Object.values(allowed)) {
    const [w, h] = value.split("x").map((n) => parseInt(n, 10));
    if (!w || !h) continue;
    const delta = Math.abs(w / h - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = { width: w, height: h };
    }
  }
  return best;
}

function failPanel(
  panel: PanelInput,
  model: string,
  transparent: boolean,
  width: number,
  height: number,
  reason: string
): PanelResult {
  return {
    job_id: panel.job_id ?? null,
    placement: panel.placement,
    file_url: null,
    file_type: "none",
    public_url: false,
    transparent_background: transparent,
    model_used: model,
    width,
    height,
    status: "failed",
    notes: `generation failed: ${reason}`,
  };
}

/** Pull the first image URL out of whatever shape imageInference returns. */
function extractImageUrl(out: any): string | null {
  if (!out) return null;
  const arr = Array.isArray(out) ? out : Array.isArray(out.data) ? out.data : [out];
  for (const item of arr) {
    const url = item?.imageURL ?? item?.imageUrl ?? item?.url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}
