/**
 * Direct Printful v2 Mockup Generator client (official mockups only).
 *
 * Used by test harnesses when full payload control is needed — e.g. products
 * with no product_options, where the hosted threadbot mockups MCP currently
 * injects `stitch_color` unconditionally and Printful rejects the task.
 * The agent pipeline continues to use the MCP tools per its frozen
 * instructions; this client renders through the exact same Printful API.
 */

import { waitForTaskWebhook } from "./mockupWaiters.js";

const PRINTFUL_API_BASE = process.env.PRINTFUL_API_BASE ?? "https://api.printful.com";

const apiKey = () => {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY is not set");
  return key;
};

/** Account-level keys require a store context for mockup tasks. */
const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiKey()}`,
  ...(process.env.PRINTFUL_STORE_ID ? { "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID } : {})
});

export interface MockupPlacementFile {
  placement: string;
  technique: string;
  fileUrl: string;
}

export interface MockupRender {
  view: string;
  style_id: number;
  mockup_url: string;
  placement: string;
}

interface TaskData {
  id: number;
  status: string;
  catalog_variant_mockups?: Array<{ mockups: MockupRender[] }>;
  failure_reasons?: unknown[];
}

/**
 * Style ids are VARIANT-specific at Printful; the catalog index merges them
 * across a product's variants, so a picked style can be invalid for the
 * resolved variant. The 400 error enumerates the valid ones — parse them and
 * self-heal (works for every product without rebuilding the index).
 */
export const parseAvailableStyleIds = (errorBody: string): number[] | null => {
  const match = errorBody.match(/Available `?style_ids`? are:\s*([0-9,\s]+)/i);
  if (!match) return null;
  const ids = match[1]
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
};

export const createAndWaitForMockups = async (params: {
  productId: number;
  variantIds: number[];
  placements: MockupPlacementFile[];
  styleIds: number[];
  /** Required product options, e.g. { stitch_color: "black" } for cut-sew apparel. */
  productOptions?: Record<string, string>;
  format?: "jpg" | "png";
  widthPx?: number;
  maxAttempts?: number;
  intervalSeconds?: number;
}): Promise<{
  status: string;
  mockups: MockupRender[];
  raw: TaskData | null;
  via?: "webhook" | "poll";
}> => {
  let styleIds = params.styleIds;
  let healedStyles = false;
  const buildBody = () => ({
    format: params.format ?? "jpg",
    width: params.widthPx ?? 1000,
    products: [
      {
        source: "catalog",
        catalog_product_id: params.productId,
        catalog_variant_ids: params.variantIds,
        mockup_style_ids: styleIds,
        ...(params.productOptions
          ? {
              product_options: Object.entries(params.productOptions).map(([name, value]) => ({
                name,
                value
              }))
            }
          : {}),
        placements: params.placements.map((p) => ({
          placement: p.placement,
          technique: p.technique,
          layers: [{ type: "file", url: p.fileUrl }]
        }))
      }
    ]
  });

  let taskId: number | null = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await fetch(`${PRINTFUL_API_BASE}/v2/mockup-tasks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(buildBody())
    });
    const created = (await response.json().catch(() => null)) as {
      data?: TaskData[];
      error?: { message?: string };
    } | null;
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 6) {
        throw new Error(`mockup-tasks HTTP ${response.status}: ${JSON.stringify(created)?.slice(0, 300)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 45000));
      continue;
    }
    if (response.status === 400 && !healedStyles) {
      const available = parseAvailableStyleIds(JSON.stringify(created) ?? "");
      if (available) {
        styleIds = available.slice(0, Math.max(1, styleIds.length));
        healedStyles = true;
        continue; // retry immediately with variant-valid styles
      }
    }
    if (!response.ok || !created?.data?.[0]?.id) {
      throw new Error(
        `mockup-tasks HTTP ${response.status}: ${JSON.stringify(created)?.slice(0, 400)}`
      );
    }
    taskId = created.data[0].id;
    break;
  }
  if (taskId === null) {
    throw new Error("mockup task was never created (rate limited on every attempt)");
  }

  const maxAttempts = params.maxAttempts ?? 30;
  const intervalMs = (params.intervalSeconds ?? 5) * 1000;
  const totalBudgetMs = maxAttempts * intervalMs;

  const finish = (task: TaskData, via: "webhook" | "poll") => {
    const mockups = (task.catalog_variant_mockups ?? []).flatMap((group) => group.mockups);
    return { status: task.status, mockups, raw: task, via };
  };

  // Race Printful's v2 `mockup_task_finished` webhook (instant) against a
  // fallback poll (first check late, then relaxed cadence) — a dropped
  // webhook delivery can never strand a run.
  const webhookWait = waitForTaskWebhook(taskId, totalBudgetMs).then((task) =>
    task ? finish(task as TaskData, "webhook") : null
  );
  const pollWait = (async () => {
    for (let poll = 0; poll < maxAttempts; poll++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const response = await fetch(`${PRINTFUL_API_BASE}/v2/mockup-tasks?id=${taskId}`, {
        headers: headers()
      });
      const polled = (await response.json().catch(() => null)) as { data?: TaskData[] } | null;
      const task = polled?.data?.[0];
      if (!task) continue;
      if (task.status === "completed" || task.status === "failed") {
        return finish(task, "poll");
      }
    }
    return null;
  })();

  const winner = await Promise.race([
    webhookWait.then((r) => r ?? pollWait),
    pollWait.then((r) => r ?? webhookWait)
  ]);
  if (winner) return winner;
  return { status: "timeout", mockups: [], raw: null, via: "poll" };
};
