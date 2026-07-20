import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runWorkflow } from "./workflow.js";

/**
 * TEMPORARY DEMO HTTP WRAPPER
 *
 * A tiny, dependency-free HTTP front door for the Threadbot Runware pipeline so
 * it can be deployed to a public host (e.g. Cloud Run) and reached from a phone
 * / the Threadbot app for a live demo. This is intentionally separate from any
 * existing deployment — it stands up a NEW service and touches nothing else.
 *
 * Endpoints:
 *   GET  /            → health/info
 *   GET  /health      → { ok: true }
 *   POST /run         → body { input_as_text | prompt | message | text }
 *                       returns { ok, status, result, elapsed_ms }
 *
 * Cloud Run provides PORT (default 8080). We bind 0.0.0.0.
 */

const PORT = Number(process.env.PORT ?? 8080);

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Accept several common field names so the app's payload is likely to match. */
function extractInput(parsed: any): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const candidate =
    parsed.input_as_text ?? parsed.prompt ?? parsed.message ?? parsed.text ?? parsed.request;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && (url === "/" || url === "/health")) {
    sendJson(res, 200, {
      ok: true,
      service: "threadbot-runware-demo",
      hint: 'POST /run with JSON { "input_as_text": "<customer request>" }',
      runware_key_present: Boolean(process.env.RUNWARE_API_KEY),
    });
    return;
  }

  if (method === "POST" && url === "/run") {
    const started = Date.now();
    let parsed: any;
    try {
      const raw = await readBody(req);
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid JSON body" });
      return;
    }

    const input = extractInput(parsed);
    if (!input) {
      sendJson(res, 400, {
        ok: false,
        error:
          'missing request text — send JSON with one of: input_as_text | prompt | message | text',
      });
      return;
    }

    try {
      const result = await runWorkflow({ input_as_text: input });
      sendJson(res, 200, {
        ok: true,
        status: (result.output_parsed as any)?.status ?? "completed",
        result: result.output_parsed,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: (err as Error).message,
        elapsed_ms: Date.now() - started,
      });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: `no route for ${method} ${url}` });
});

server.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`threadbot-runware-demo listening on :${PORT}`);
});
