/**
 * Threadbot pipeline HTTP service (deployed as Cloud Run
 * `threadbot-agentic-pipeline` — the backend the mobile app calls).
 *
 * API:
 *   GET  /healthz                     liveness + provider/config summary
 *   POST /runs                        start a run
 *        body: { input_as_text: string, input_image_urls?: string[] (<=10) }
 *        query ?sync=1 to block until the run finishes (long!)
 *        default: returns { run_id } immediately
 *   GET  /runs/:id                    run status + final output when done
 *
 * Runs are kept in memory (Cloud Run min-instances >= 1 recommended for
 * polling); each response includes `status`: queued | running | completed |
 * failed.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { runWorkflow, MAX_CUSTOMER_IMAGES } from "./workflow.js";
import { activeProviderName, usageTally } from "./llm/provider.js";

interface RunRecord {
  run_id: string;
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  finished_at?: string;
  result?: unknown;
  error?: string;
  llm_usage?: { calls: number; input_tokens: number; output_tokens: number };
}

const runs = new Map<string, RunRecord>();
const MAX_KEPT_RUNS = 200;

const prune = () => {
  while (runs.size > MAX_KEPT_RUNS) {
    const oldest = runs.keys().next().value;
    if (!oldest) break;
    runs.delete(oldest);
  }
};

const startRun = (input: { input_as_text: string; input_image_urls?: string[] }): RunRecord => {
  const record: RunRecord = {
    run_id: randomUUID(),
    status: "queued",
    created_at: new Date().toISOString()
  };
  runs.set(record.run_id, record);
  prune();
  void (async () => {
    record.status = "running";
    const before = { ...usageTally };
    try {
      const result = await runWorkflow(input);
      record.result = result.output_parsed;
      record.status = "completed";
    } catch (error) {
      record.error = (error as Error).message.slice(0, 2000);
      record.status = "failed";
    } finally {
      record.finished_at = new Date().toISOString();
      record.llm_usage = {
        calls: usageTally.calls - before.calls,
        input_tokens: usageTally.input_tokens - before.input_tokens,
        output_tokens: usageTally.output_tokens - before.output_tokens
      };
    }
  })();
  return record;
};

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(payload);
};

const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("request body exceeds 1MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    // NOTE: /healthz is reserved/intercepted by Google's frontend on
    // run.app default URLs — it never reaches the container. Use /health.
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      return json(res, 200, {
        ok: true,
        service: "threadbot-agentic-pipeline",
        llm_provider: activeProviderName(),
        artwork: process.env.THREADBOT_ARTWORK_MCP_URL ? "hosted-artwork-mcp" : "runware-local",
        max_customer_images: MAX_CUSTOMER_IMAGES
      });
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      const raw = await readBody(req);
      let body: { input_as_text?: unknown; input_image_urls?: unknown };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "body must be JSON" });
      }
      const text = typeof body.input_as_text === "string" ? body.input_as_text.trim() : "";
      const images = Array.isArray(body.input_image_urls)
        ? body.input_image_urls.filter((u): u is string => typeof u === "string")
        : [];
      if (!text && !images.length) {
        return json(res, 400, { error: "input_as_text or input_image_urls required" });
      }
      const record = startRun({
        input_as_text: text || "Design a product from the attached reference images.",
        input_image_urls: images
      });
      if (url.searchParams.get("sync") === "1") {
        while (record.status === "queued" || record.status === "running") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return json(res, record.status === "completed" ? 200 : 500, record);
      }
      return json(res, 202, { run_id: record.run_id, status: record.status });
    }
    const runMatch = url.pathname.match(/^\/runs\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && runMatch) {
      const record = runs.get(runMatch[1]);
      if (!record) return json(res, 404, { error: "run not found" });
      return json(res, 200, record);
    }
    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 500, { error: (error as Error).message.slice(0, 500) });
  }
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(
    JSON.stringify({
      event: "threadbot_pipeline_listening",
      port,
      llm_provider: activeProviderName()
    })
  );
});
