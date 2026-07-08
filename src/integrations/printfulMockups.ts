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
  /** Print-area pixel dims (v1 requires an explicit full-bleed position). */
  widthPx?: number;
  heightPx?: number;
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

/**
 * v1 mockup generator: the road-tested fast path. v2 (beta) parks tasks in
 * 'pending' for 10+ minutes when a task carries several never-before-seen
 * files (proven by isolation: 6 fresh files jam from ANY host and ANY
 * creator; 0-1 fresh files render in <60s; the same 6 files re-submitted
 * after ingest render in 45s). v1 rendered 6 fresh files in 32s flat, so
 * multi-placement tasks go v1; single-placement keeps v2 + the webhook race.
 */
const runV1 = async (params: Parameters<typeof createAndWaitForMockups>[0]): Promise<{
  status: string;
  mockups: MockupRender[];
  raw: TaskData | null;
  via?: "webhook" | "poll";
}> => {
  const body = {
    variant_ids: params.variantIds,
    format: params.format ?? "jpg",
    files: params.placements.map((p) => {
      const w = Math.max(16, Math.round(p.widthPx ?? 4000));
      const h = Math.max(16, Math.round(p.heightPx ?? 4000));
      return {
        placement: p.placement,
        image_url: p.fileUrl,
        position: { area_width: w, area_height: h, width: w, height: h, top: 0, left: 0 }
      };
    })
  };
  // Create-task retries: Printful rate-limits bursts with a 429 that names
  // its own cool-down ("try again after N seconds") — honor it instead of
  // failing the whole run (live incident: 5 perfect panels thrown away).
  type CreateBody = { result?: { task_key?: string }; error?: { message?: string } } | null;
  let created!: Response;
  let createdBody: CreateBody = null;
  let taskKey: string | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    created = await fetch(
      `${PRINTFUL_API_BASE}/mockup-generator/create-task/${params.productId}`,
      { method: "POST", headers: headers(), body: JSON.stringify(body) }
    );
    createdBody = (await created.json().catch(() => null)) as CreateBody;
    taskKey = createdBody?.result?.task_key;
    if ((created.status === 429 || created.status >= 500) && attempt < 4) {
      const hinted = JSON.stringify(createdBody)?.match(/after (\d+) seconds/);
      const waitSec = Math.min(90, hinted ? Number(hinted[1]) + 2 : 15 * attempt);
      params.onEvent?.(`v1 create-task HTTP ${created.status} — retrying in ${waitSec}s`);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      continue;
    }
    break;
  }
  if (!created.ok || !taskKey) {
    throw new Error(
      `v1 create-task HTTP ${created.status}: ${JSON.stringify(createdBody)?.slice(0, 300)}`
    );
  }
  params.onEvent?.(`v1 task created: ${taskKey}`);
  const maxAttempts = params.maxAttempts ?? 60;
  const intervalMs = (params.intervalSeconds ?? 5) * 1000;
  for (let poll = 0; poll < maxAttempts; poll++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch(
      `${PRINTFUL_API_BASE}/mockup-generator/task?task_key=${encodeURIComponent(taskKey)}`,
      { headers: headers() }
    );
    if (response.status === 429) {
      params.onEvent?.(`v1 poll ${poll}: 429 — backing off`);
      await new Promise((resolve) => setTimeout(resolve, 20000));
      continue;
    }
    const polled = (await response.json().catch(() => null)) as {
      result?: {
        status?: string;
        error?: string;
        mockups?: Array<{
          placement?: string;
          mockup_url?: string;
          extra?: Array<{ option?: string; url?: string }>;
        }>;
      };
    } | null;
    const status = polled?.result?.status;
    if (poll % 6 === 0 || status !== "pending") {
      params.onEvent?.(`v1 poll ${poll}: HTTP ${response.status} status=${status ?? "?"}`);
    }
    if (status === "completed") {
      const mockups: MockupRender[] = [];
      for (const m of polled?.result?.mockups ?? []) {
        if (m.mockup_url) {
          mockups.push({ view: m.placement ?? "front", style_id: 0, mockup_url: m.mockup_url, placement: m.placement ?? "front" });
        }
        for (const extra of m.extra ?? []) {
          if (extra.url) {
            mockups.push({ view: extra.option ?? "extra", style_id: 0, mockup_url: extra.url, placement: m.placement ?? "front" });
          }
        }
      }
      return { status: "completed", mockups, raw: null, via: "poll" };
    }
    if (status === "failed") {
      return { status: "failed", mockups: [], raw: { id: 0, status: "failed", failure_reasons: [polled?.result?.error ?? "v1 task failed"] }, via: "poll" };
    }
  }
  return { status: "timeout", mockups: [], raw: null, via: "poll" };
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
  /** Diagnostic hook: called with poll/webhook lifecycle events. */
  onEvent?: (info: string) => void;
}): Promise<{
  status: string;
  mockups: MockupRender[];
  raw: TaskData | null;
  via?: "webhook" | "poll";
}> => {
  // Multi-file tasks go v1 (fast, proven); v2 beta jams on several fresh files.
  if (params.placements.length >= 2) {
    return runV1(params);
  }
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
    params.onEvent?.(`task created: ${taskId}`);
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
    let lastSeen = "";
    for (let poll = 0; poll < maxAttempts; poll++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      let response: Response;
      try {
        response = await fetch(`${PRINTFUL_API_BASE}/v2/mockup-tasks?id=${taskId}`, {
          headers: headers()
        });
      } catch (error) {
        params.onEvent?.(`poll ${poll}: FETCH ERROR ${(error as Error).message.slice(0, 120)}`);
        continue;
      }
      if (response.status === 429) {
        params.onEvent?.(`poll ${poll}: 429 rate limited — backing off`);
        await new Promise((resolve) => setTimeout(resolve, 30000));
        continue;
      }
      const polled = (await response.json().catch(() => null)) as { data?: TaskData[] } | null;
      const task = polled?.data?.[0];
      const seen = `HTTP ${response.status} status=${task?.status ?? "none"}`;
      if (seen !== lastSeen || poll % 10 === 0) {
        params.onEvent?.(`poll ${poll}: ${seen}${task ? "" : ` body=${JSON.stringify(polled)?.slice(0, 160)}`}`);
        lastSeen = seen;
      }
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
