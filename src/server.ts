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
import { readFileSync } from "node:fs";
import path from "node:path";
import { runWorkflow, MAX_CUSTOMER_IMAGES } from "./workflow.js";
import { runExpress } from "./express/run.js";
import { catalogSize, getCatalogRecord, searchCatalog } from "./express/catalog.js";
import { hostedImages, putHostedImage } from "./hosting.js";
import { resolveTaskWebhook, webhookStats } from "./integrations/mockupWaiters.js";
import { PrintfulTruth } from "./express/truth.js";
import {
  decodeUserId,
  fetchTaste,
  looksLikeUserToken,
  tasteHintLine,
  updateTaste
} from "./express/taste.js";
import { activeProviderName, usageTally } from "./llm/provider.js";
import {
  createCheckoutSession,
  shippingFlatCents,
  stripeConfigured,
  verifyStripeSignature
} from "./commerce/stripe.js";
import { normalizeShippingCountry, quoteShipping } from "./commerce/shipping.js";
import {
  designRegistrySize,
  getDesign,
  lookupOrderStatus,
  placePrintfulOrder,
  registerDesign,
  type OrderRecipient
} from "./commerce/orders.js";

/** Product truth for the /generate commerce block (cached, free reads). */
const commerceTruth = new PrintfulTruth();

/** Stripe sessions already fulfilled (webhooks redeliver; orders must not). */
const processedCheckoutSessions = new Set<string>();

/**
 * Post-payment return page: confirms the outcome and deep-links back into
 * the app (scheme is env-tunable; default matches the mobile appId).
 */
const checkoutReturnPage = (ok: boolean): string => {
  const scheme = process.env.THREADBOT_APP_SCHEME ?? "threadbot";
  const deepLink = `${scheme}://checkout?status=${ok ? "success" : "cancel"}`;
  const title = ok ? "Payment complete" : "Checkout canceled";
  const body = ok
    ? "Your order is in. It's being sent to production — you can close this tab and return to Threadbot."
    : "No charge was made. Return to Threadbot and try again whenever you're ready.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Threadbot</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% -10%,#0c1622,#07080a 60%);color:#cfe9ee;font-family:system-ui,sans-serif;text-align:center;padding:24px}
h1{color:${ok ? "#19f0c4" : "#ff7b7b"};font-size:23px;letter-spacing:1px;margin:0 0 10px}p{opacity:.72;font-size:14px;max-width:330px;line-height:1.55;margin:0}a{margin-top:24px;color:#04181c;background:#00E5FF;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:700;letter-spacing:1px}</style></head>
<body><h1>${title}</h1><p>${body}</p><a href="${deepLink}">Return to Threadbot</a>
<script>setTimeout(function(){try{location.href=${JSON.stringify(deepLink)}}catch(e){}},700)</script></body></html>`;
};

type RunMode = "express" | "agents";

/**
 * Express (one light LLM call + one master image + deterministic panels +
 * official mockups, cents per run) is the DEFAULT; the 13-agent pipeline is
 * the opt-in premium/fallback mode. Overridable per deployment and per run.
 */
const defaultMode = (): RunMode =>
  process.env.THREADBOT_DEFAULT_MODE === "agents" ? "agents" : "express";

interface RunRecord {
  run_id: string;
  mode: RunMode;
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

const startRun = (
  input: {
    input_as_text: string;
    input_image_urls?: string[];
    product_id?: number;
    variant_id?: number;
  },
  mode: RunMode
): RunRecord => {
  const record: RunRecord = {
    run_id: randomUUID(),
    mode,
    status: "queued",
    created_at: new Date().toISOString()
  };
  runs.set(record.run_id, record);
  prune();
  void (async () => {
    record.status = "running";
    const before = { ...usageTally };
    try {
      if (mode === "express") {
        record.result = await runExpress(input);
      } else {
        const result = await runWorkflow(input);
        record.result = result.output_parsed;
      }
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

const readBody = (
  req: import("node:http").IncomingMessage,
  maxBytes = 1_000_000
): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${Math.round(maxBytes / 1_000_000)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// -----------------------------------------------------------------------------
// Customer image uploads + generated-panel hosting: shared in-memory store
// (src/hosting.ts) served at /uploads/:id. The app sends local photos as
// base64; the OpenAI media adapter hosts generated print files here too.
// -----------------------------------------------------------------------------

const UPLOAD_MAX_ONE_BYTES = 6_000_000;

const publicBaseUrl = (req: import("node:http").IncomingMessage): string => {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
};

// -----------------------------------------------------------------------------
// Built-in frontend: served by the same service so the UI can never drift
// from the API it talks to.
// -----------------------------------------------------------------------------

const loadFrontend = (): string | null => {
  const candidates = [
    path.resolve(process.cwd(), "frontend/index.html"),
    new URL("../frontend/index.html", import.meta.url).pathname
  ];
  for (const file of candidates) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      // try next
    }
  }
  return null;
};
let frontendHtml: string | null = null;

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
        default_mode: defaultMode(),
        catalog_products: catalogSize(),
        max_customer_images: MAX_CUSTOMER_IMAGES,
        commerce: {
          stripe: stripeConfigured(),
          webhook_secret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
          order_mode: process.env.THREADBOT_ORDER_CONFIRM === "1" ? "auto-confirm" : "draft",
          registered_designs: designRegistrySize()
        }
      });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (frontendHtml === null) frontendHtml = loadFrontend();
      if (frontendHtml) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(frontendHtml);
        return;
      }
      return json(res, 200, { service: "threadbot-agentic-pipeline", ui: "not bundled" });
    }
    // Printful v2 `mockup_task_finished` webhook: resolves in-flight mockup
    // waits instantly (polling remains the fallback race). Token-guarded —
    // the registered URL carries ?token=THREADBOT_WEBHOOK_TOKEN.
    if (req.method === "POST" && url.pathname === "/webhooks/printful") {
      const expected = process.env.THREADBOT_WEBHOOK_TOKEN ?? "";
      if (!expected || url.searchParams.get("token") !== expected) {
        return json(res, 403, { error: "bad token" });
      }
      const raw = await readBody(req, 4_000_000);
      let event: { type?: string; data?: { id?: number } };
      try {
        event = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "body must be JSON" });
      }
      if (event.type === "mockup_task_finished" && typeof event.data?.id === "number") {
        resolveTaskWebhook(event.data as Parameters<typeof resolveTaskWebhook>[0]);
      }
      return json(res, 200, { ok: true });
    }
    // -------------------------------------------------------------------------
    // Commerce bridge: Stripe Checkout in, Printful order out.
    //   POST /checkout          app Buy button -> hosted Stripe payment page
    //   POST /webhooks/stripe   checkout.session.completed -> Printful order
    //   GET  /checkout/success|cancel   return pages that deep-link to the app
    // -------------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/checkout") {
      if (!stripeConfigured()) {
        return json(res, 503, {
          error: "Ordering isn't live yet — payments are still being connected. Your design is saved."
        });
      }
      const raw = await readBody(req, 100_000);
      let body: {
        designId?: unknown;
        size?: unknown;
        color?: unknown;
        quantity?: unknown;
        country?: unknown;
      };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "body must be JSON" });
      }
      const designId = typeof body.designId === "string" ? body.designId : "";
      const design = designId ? getDesign(designId) : null;
      if (!design) {
        return json(res, 404, {
          error:
            "This design's order window has expired. Open it in your closet and regenerate to order."
        });
      }
      const quantity = Math.max(1, Math.min(10, Number(body.quantity) || 1));
      const size = typeof body.size === "string" ? body.size.slice(0, 24) : "";
      const color = typeof body.color === "string" ? body.color.slice(0, 40) : "";
      // Size/color picks re-resolve the variant; price stays the run's
      // server-computed retail (client-sent prices are never trusted).
      let variantId = design.variant_id;
      if (size || color) {
        try {
          variantId = await commerceTruth.resolveVariant(
            design.product_id,
            `${color} ${size}`.trim()
          );
        } catch (error) {
          console.error(`[checkout] variant resolve failed: ${(error as Error).message}`);
        }
      }
      // Shipping: charge the supplier's real rate for the chosen destination
      // (flat guesses lose money); the Stripe page locks address entry to the
      // quoted country so charged always equals shipped. Quote failure falls
      // back to the flat knob, restricted to US.
      const country = normalizeShippingCountry(body.country);
      const shippingQuote = await quoteShipping(variantId, quantity, country);
      const metadata: Record<string, string> = {
        run_id: design.run_id,
        design_id: designId,
        product_id: String(design.product_id),
        variant_id: String(variantId),
        size,
        color,
        country,
        quantity: String(quantity),
        product_name: design.product_name.slice(0, 120),
        retail_usd: design.retail_usd.toFixed(2)
      };
      // Self-contained fulfillment: panels ride the session metadata, so a
      // restart between checkout and webhook can't orphan the order.
      design.placements.slice(0, 8).forEach((panel, i) => {
        metadata[`panel_${i}`] = `${panel.placement}|${panel.technique}|${panel.file_url}`;
      });
      if (design.product_options) {
        metadata.product_options = JSON.stringify(design.product_options).slice(0, 500);
      }
      try {
        const base = publicBaseUrl(req);
        const session = await createCheckoutSession({
          productName: design.product_name,
          description: `Custom ${design.product_name} — made to order from your Threadbot design`,
          imageUrl: design.mockup_url ?? undefined,
          unitAmountCents: Math.round(design.retail_usd * 100),
          quantity,
          shippingCents: shippingQuote?.cents ?? shippingFlatCents(),
          shippingLabel: shippingQuote?.display_name,
          allowedCountries: shippingQuote ? [country] : ["US"],
          successUrl: `${base}/checkout/success`,
          cancelUrl: `${base}/checkout/cancel`,
          metadata
        });
        return json(res, 200, { url: session.url, sessionId: session.id });
      } catch (error) {
        console.error(`[checkout] ${(error as Error).message}`);
        return json(res, 502, { error: "Checkout couldn't be started. Please try again." });
      }
    }
    if (req.method === "POST" && url.pathname === "/webhooks/stripe") {
      const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
      const raw = await readBody(req, 2_000_000);
      if (!verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, secret)) {
        return json(res, 400, { error: "bad signature" });
      }
      let event: {
        type?: string;
        data?: { object?: Record<string, unknown> };
      };
      try {
        event = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "body must be JSON" });
      }
      if (event.type === "checkout.session.completed" && event.data?.object) {
        const session = event.data.object as {
          id?: string;
          metadata?: Record<string, string>;
          amount_total?: number;
          customer_details?: { email?: string; name?: string; address?: Record<string, string> };
          shipping_details?: { name?: string; address?: Record<string, string> };
          collected_information?: {
            shipping_details?: { name?: string; address?: Record<string, string> };
          };
        };
        const sessionId = session.id ?? "";
        if (sessionId && !processedCheckoutSessions.has(sessionId)) {
          processedCheckoutSessions.add(sessionId);
          if (processedCheckoutSessions.size > 5000) {
            const oldest = processedCheckoutSessions.values().next().value;
            if (oldest) processedCheckoutSessions.delete(oldest);
          }
          const meta = session.metadata ?? {};
          // Registry first (fresh instance), metadata fallback (restarted one).
          const registered = meta.run_id ? getDesign(meta.run_id) : null;
          const placements =
            registered?.placements ??
            Object.keys(meta)
              .filter((key) => /^panel_\d+$/.test(key))
              .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
              .map((key) => {
                const [placement, technique, ...rest] = meta[key].split("|");
                return { placement, technique, file_url: rest.join("|") };
              })
              .filter((panel) => panel.placement && /^https?:\/\//.test(panel.file_url));
          const shipping =
            session.collected_information?.shipping_details ??
            session.shipping_details ??
            session.customer_details ??
            {};
          const address = (shipping as { address?: Record<string, string> }).address ?? {};
          const recipient: OrderRecipient = {
            name:
              (shipping as { name?: string }).name ?? session.customer_details?.name ?? "Customer",
            address1: address.line1 ?? "",
            ...(address.line2 ? { address2: address.line2 } : {}),
            city: address.city ?? "",
            ...(address.state ? { state_code: address.state } : {}),
            country_code: address.country ?? "US",
            zip: address.postal_code ?? "",
            ...(session.customer_details?.email ? { email: session.customer_details.email } : {})
          };
          let productOptions: Record<string, string> | undefined = registered?.product_options;
          if (!productOptions && meta.product_options) {
            try {
              productOptions = JSON.parse(meta.product_options);
            } catch {
              /* metadata was truncated — order proceeds without options */
            }
          }
          if (!placements.length) {
            console.error(`[orders] session ${sessionId} has no recoverable print files`);
          } else {
            try {
              const order = await placePrintfulOrder({
                record: {
                  run_id: meta.run_id ?? sessionId,
                  product_id: Number(meta.product_id) || 0,
                  variant_id: Number(meta.variant_id) || 0,
                  product_name: meta.product_name ?? "Threadbot custom product",
                  retail_usd: Number(meta.retail_usd) || 0,
                  mockup_url: null,
                  placements,
                  ...(productOptions ? { product_options: productOptions } : {}),
                  created_at: Date.now()
                },
                catalogVariantId: Number(meta.variant_id) || 0,
                quantity: Number(meta.quantity) || 1,
                recipient,
                externalId: sessionId,
                retailPerItemUsd: Number(meta.retail_usd) || 0,
                confirm: process.env.THREADBOT_ORDER_CONFIRM === "1"
              });
              console.log(
                `[orders] session ${sessionId} -> printful order ${order.order_id} (${order.status}${order.confirmed ? ", confirmed" : ", draft"})`
              );
            } catch (error) {
              // 200 to Stripe regardless — a retry storm can't fix a bad
              // order; the failure is logged with the session id for replay.
              console.error(`[orders] session ${sessionId} failed: ${(error as Error).message}`);
            }
          }
        }
      }
      return json(res, 200, { received: true });
    }
    // Live order status for the app's Orders tab (session ids are the join
    // key and are unguessable; supplier vocabulary is translated).
    if (req.method === "GET" && url.pathname === "/orders/status") {
      const sessionId = url.searchParams.get("session_id") ?? "";
      if (!/^cs_[A-Za-z0-9_]{10,120}$/.test(sessionId)) {
        return json(res, 400, { error: "bad session id" });
      }
      try {
        return json(res, 200, await lookupOrderStatus(sessionId));
      } catch (error) {
        console.error(`[orders] status lookup failed: ${(error as Error).message}`);
        return json(res, 200, { state: "unknown", label: "Status unavailable" });
      }
    }
    if (req.method === "GET" && (url.pathname === "/checkout/success" || url.pathname === "/checkout/cancel")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(checkoutReturnPage(url.pathname === "/checkout/success"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/debug/hosting") {
      let total = 0;
      for (const record of hostedImages.values()) total += record.bytes.length;
      return json(res, 200, {
        images: hostedImages.size,
        total_mb: Math.round(total / 1e6),
        webhook: webhookStats
      });
    }
    if (req.method === "GET" && url.pathname === "/catalog") {
      const query = url.searchParams.get("q") ?? "";
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      return json(res, 200, { count: catalogSize(), products: searchCatalog(query, limit) });
    }
    const catalogMatch = url.pathname.match(/^\/catalog\/(\d{1,6})$/);
    if (req.method === "GET" && catalogMatch) {
      const record = getCatalogRecord(Number(catalogMatch[1]));
      if (!record) return json(res, 404, { error: "product not in catalog index" });
      return json(res, 200, record);
    }
    // -------------------------------------------------------------------------
    // Threadbot mobile app contract (the original frontend's ONE seam):
    //   POST /generate { prompt, refImage?, refImages?, remix?, baseImage? }
    //   -> { variations: [{ id, image }, ...] }
    // Images arrive as data-URLs; they are hosted and fed to the express run
    // as reference inputs. Variations are the OFFICIAL Printful mockup views.
    // -------------------------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/generate") {
      const raw = await readBody(req, 24_000_000);
      let body: {
        prompt?: unknown;
        refImage?: unknown;
        refImages?: unknown;
        remix?: unknown;
        baseImage?: unknown;
      };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "body must be JSON" });
      }
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const candidates: unknown[] = [
        body.refImage,
        ...(Array.isArray(body.refImages) ? body.refImages : []),
        ...(body.remix === true ? [body.baseImage] : [])
      ];
      const imageUrls: string[] = [];
      for (const candidate of candidates) {
        if (typeof candidate !== "string" || !candidate) continue;
        if (imageUrls.length >= MAX_CUSTOMER_IMAGES) break;
        if (/^https?:\/\//.test(candidate)) {
          imageUrls.push(candidate);
        } else if (candidate.startsWith("data:image/")) {
          const bytes = Buffer.from(candidate.replace(/^data:[^,]*,/, ""), "base64");
          if (bytes.length && bytes.length <= UPLOAD_MAX_ONE_BYTES) {
            const match = candidate.match(/^data:(image\/[a-z+.-]+)/i);
            const id = putHostedImage(bytes, match?.[1] ?? "image/png");
            imageUrls.push(`${publicBaseUrl(req)}/uploads/${id}`);
          }
        }
      }
      if (!prompt && !imageUrls.length) {
        return json(res, 400, { error: "prompt or reference image required" });
      }
      // Per-user taste: soft hints from this customer's history, scoped by
      // RLS through their own bearer token. Fails soft in every direction.
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const taste = looksLikeUserToken(bearer) ? await fetchTaste(bearer) : null;
      const hint = tasteHintLine(taste);
      const before = { ...usageTally };
      const result = await runExpress({
        input_as_text:
          (prompt || "Design a product from the attached reference images.") +
          (hint
            ? `\n\n[Platform taste hints — soft preferences from this customer's history; use ONLY for unspecified details, never override the request: ${hint}]`
            : ""),
        input_image_urls: imageUrls
      });
      if (result.status === "completed" && result.intent && looksLikeUserToken(bearer)) {
        const userId = decodeUserId(bearer);
        if (userId) {
          void updateTaste(bearer, userId, result.intent, result.product.name, taste);
        }
      }
      const variations = [...new Set(result.mockups.map((m) => m.mockup_url))]
        .slice(0, 4)
        .map((mockupUrl, i) => ({ id: `${result.run_id}-${i}`, image: mockupUrl }));
      if (result.status !== "completed" || !variations.length) {
        return json(res, result.status === "refused" ? 422 : 502, {
          error: result.message || "generation failed",
          run_id: result.run_id,
          status: result.status,
          // Diagnostics: paid work must never be opaque — surface exactly
          // what was produced and why the run stopped.
          product: result.product,
          panels: result.panels.map((p) => ({ placement: p.placement, status: p.status, file_url: p.file_url })),
          failure_details: result.missing_required_placements
        });
      }
      // Order truth: what the Buy button purchases is EXACTLY what the
      // mockups rendered — same print files, same variant, same options.
      registerDesign({
        run_id: result.run_id,
        product_id: result.product.id,
        variant_id: result.product.variant_id ?? 0,
        product_name: result.product.name,
        retail_usd: result.economics.retail_anchor_usd,
        mockup_url: variations[0]?.image ?? null,
        placements: result.submitted_placements.map(({ placement, technique, file_url }) => ({
          placement,
          technique,
          file_url
        })),
        ...(result.product_options ? { product_options: result.product_options } : {}),
        created_at: Date.now()
      });
      // Checkout-sheet truth: real product name, price, and purchasable
      // size/color axes — never static placeholders.
      let matrix: { sizes: string[]; colors: string[] } = { sizes: [], colors: [] };
      try {
        matrix = await commerceTruth.variantMatrix(result.product.id);
      } catch (error) {
        console.error(`[generate] variant matrix unavailable: ${(error as Error).message}`);
      }
      return json(res, 200, {
        variations,
        run_id: result.run_id,
        product: result.product,
        message: result.message,
        retail_usd: result.economics.retail_anchor_usd,
        commerce: {
          product_id: result.product.id,
          variant_id: result.product.variant_id,
          product_name: result.product.name,
          retail_usd: result.economics.retail_anchor_usd,
          base_cost_usd: result.economics.base_cost_anchor_usd,
          sizes: matrix.sizes,
          colors: matrix.colors
        },
        llm_usage: {
          calls: usageTally.calls - before.calls,
          input_tokens: usageTally.input_tokens - before.input_tokens,
          output_tokens: usageTally.output_tokens - before.output_tokens
        }
      });
    }
    // Mirror proxy: lets the mobile app read Printful mockup images (no CORS
    // on their S3) so it can persist them into the user's Supabase Storage.
    // Restricted to Printful-owned hosts — this is NOT an open proxy.
    if (req.method === "GET" && url.pathname === "/mirror") {
      const src = url.searchParams.get("src") ?? "";
      let host = "";
      try {
        host = new URL(src).hostname;
      } catch {
        return json(res, 400, { error: "src must be a URL" });
      }
      const allowed =
        host === "printful-upload.s3-accelerate.amazonaws.com" ||
        host.endsWith(".printful.com") ||
        host === "files.cdn.printful.com";
      if (!allowed) return json(res, 403, { error: "host not allowed" });
      const upstream = await fetch(src);
      if (!upstream.ok) return json(res, 502, { error: `upstream HTTP ${upstream.status}` });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > 15_000_000) return json(res, 502, { error: "image too large" });
      res.writeHead(200, {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Content-Length": bytes.length,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600"
      });
      res.end(bytes);
      return;
    }
    if (req.method === "POST" && url.pathname === "/uploads") {
      const raw = await readBody(req, 9_000_000);
      let body: { data_base64?: unknown; content_type?: unknown };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "body must be JSON { data_base64, content_type }" });
      }
      const data = typeof body.data_base64 === "string" ? body.data_base64 : "";
      const contentType =
        typeof body.content_type === "string" && /^image\//.test(body.content_type)
          ? body.content_type
          : "image/jpeg";
      if (!data) return json(res, 400, { error: "data_base64 required" });
      let bytes: Buffer;
      try {
        bytes = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
      } catch {
        return json(res, 400, { error: "data_base64 is not valid base64" });
      }
      if (!bytes.length || bytes.length > UPLOAD_MAX_ONE_BYTES) {
        return json(res, 400, { error: `image must be 1 byte to ${UPLOAD_MAX_ONE_BYTES} bytes` });
      }
      const id = putHostedImage(bytes, contentType);
      return json(res, 201, { upload_id: id, url: `${publicBaseUrl(req)}/uploads/${id}` });
    }
    const uploadMatch = url.pathname.match(/^\/uploads\/([0-9a-f-]{36})$/);
    // HEAD must work: Printful preflights print files with HEAD before
    // downloading — a GET-only route made it read live files as missing.
    if ((req.method === "GET" || req.method === "HEAD") && uploadMatch) {
      const record = hostedImages.get(uploadMatch[1]);
      if (!record) return json(res, 404, { error: "upload not found or expired" });
      res.writeHead(200, {
        "Content-Type": record.contentType,
        "Content-Length": record.bytes.length,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(req.method === "HEAD" ? undefined : record.bytes);
      return;
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      const raw = await readBody(req);
      let body: {
        input_as_text?: unknown;
        input_image_urls?: unknown;
        mode?: unknown;
        product_id?: unknown;
        variant_id?: unknown;
      };
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
      const mode: RunMode =
        body.mode === "agents" || body.mode === "express" ? body.mode : defaultMode();
      const asId = (value: unknown): number | undefined => {
        const parsed = typeof value === "string" ? Number(value) : (value as number);
        return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
          ? Math.round(parsed)
          : undefined;
      };
      const record = startRun(
        {
          input_as_text: text || "Design a product from the attached reference images.",
          input_image_urls: images,
          product_id: asId(body.product_id),
          variant_id: asId(body.variant_id)
        },
        mode
      );
      if (url.searchParams.get("sync") === "1") {
        while (record.status === "queued" || record.status === "running") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return json(res, record.status === "completed" ? 200 : 500, record);
      }
      return json(res, 202, { run_id: record.run_id, status: record.status, mode: record.mode });
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
