/**
 * HTTP surface: the interactive preview endpoint, and the Stripe webhook that is the
 * ONLY trigger for fulfillment.
 *
 *   POST /preview          { prompt, imageUrls?, defaultSize? }  -> preview + designId
 *   POST /webhooks/stripe  (checkout.session.completed)          -> fulfillOrder(...)
 *
 * Keep the webhook fast and idempotent in production (enqueue a job, dedupe on
 * session.id). Here it awaits inline for clarity.
 */

import "./net.js"; // force IPv4 egress before any outbound request (must be first)
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import Stripe from "stripe";
import { config } from "./config.js";
import { FakeBrain, OpenAIBrain, type Brain, type CatalogProduct } from "./core/ai.js";
import { fulfillOrder } from "./core/fulfill.js";
import { generatePreview } from "./core/preview.js";
import { generateVariations } from "./core/generate.js";
import { InMemorySpecStore, LocalImageStore, type ImageStore, type SpecStore } from "./core/store.js";
import { StaticCatalogRetriever, type CatalogRetriever } from "./core/retriever.js";
import { SupabaseImageStore, SupabaseSpecStore, createSupabase } from "./core/supabaseStore.js";
import type { Recipient } from "./core/designSpec.js";
import { PrintfulProvider } from "./providers/printful.js";

async function main() {
  const catalog: CatalogProduct[] = JSON.parse(
    await readFile(join(process.cwd(), "data/catalog.json"), "utf8")
  );

  const brain: Brain = config.openai.apiKey
    ? new OpenAIBrain(
        config.openai.apiKey,
        config.openai.textModel,
        config.openai.imageModel,
        config.openai.imageSize
      )
    : new FakeBrain();

  const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);
  const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

  let specs: SpecStore;
  let images: ImageStore;
  let retriever: CatalogRetriever;
  let supabaseAdmin: ReturnType<typeof createSupabase> | null = null;

  if (config.supabase.url && config.supabase.serviceRoleKey) {
    const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
    supabaseAdmin = sb;
    specs = new SupabaseSpecStore(sb);
    images = new SupabaseImageStore(sb, config.supabase.bucket);
    retriever = new StaticCatalogRetriever(catalog);
    console.log("persistence: supabase");
  } else {
    specs = new InMemorySpecStore();
    images = new LocalImageStore(join(process.cwd(), "public"), config.publicBaseUrl);
    retriever = new StaticCatalogRetriever(catalog);
    console.log("persistence: in-memory + local disk");
  }

  const app = express();
  app.use("/public", express.static(join(process.cwd(), "public")));

  // Stripe needs the raw body for signature verification — mount before express.json().
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"] as string,
        config.stripe.webhookSecret
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const designId = session.metadata?.design_id;
      if (designId) {
        try {
          const result = await fulfillOrder(
            { provider, specs },
            {
              designId,
              recipient: recipientFromSession(session),
              size: session.metadata?.size ?? "UNRESOLVED",
              quantity: parseInt(session.metadata?.quantity ?? "1", 10),
              externalId: session.id,
              chargedAmount:
                session.amount_total != null
                  ? {
                      amount: session.amount_total / 100,
                      currency: (session.currency ?? "usd").toUpperCase(),
                    }
                  : undefined,
            }
          );
          console.log(`[fulfill] ${designId} -> ${result.status} ${result.reason ?? result.providerOrderId ?? ""}`);
        } catch (err) {
          // In production: alert + retry/refund flow. Don't 500 Stripe into a retry storm.
          console.error(`[fulfill] ${designId} failed:`, err);
        }
      }
    }
    res.json({ received: true });
  });

  app.use(express.json({ limit: "25mb" }));

  // CORS so the Capacitor WebView (and web builds) can call the API cross-origin.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Verify a Supabase Auth bearer token -> user id. When Supabase isn't configured
  // (local dev) auth is skipped. Sends 401 and returns null on failure.
  async function requireUser(req: express.Request, res: express.Response): Promise<string | null> {
    if (!supabaseAdmin) return "dev-user";
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : "";
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: "authentication required" });
      return null;
    }
    return data.user.id;
  }

  // The mobile UI's one backend call -> { variations: [{ id, image }] }.
  app.post("/generate", async (req, res) => {
    const userId = await requireUser(req, res);
    if (!userId) return;
    const { prompt, refImage, remix, baseImage } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt (string) is required" });
    }
    try {
      const result = await generateVariations(
        { brain, provider, specs, images, retriever, providerName: "printful" },
        { prompt, refImage, remix, baseImage, count: config.generateVariations }
      );
      res.json(result);
    } catch (err) {
      console.error("[generate] failed:", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/preview", async (req, res) => {
    const { prompt, imageUrls, defaultSize } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt (string) is required" });
    }
    try {
      const result = await generatePreview(
        { brain, provider, specs, images, retriever, providerName: "printful" },
        { prompt, imageUrls, defaultSize }
      );
      res.json(result);
    } catch (err) {
      console.error("[preview] failed:", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Create a Stripe Checkout Session for a finished design. The webhook (above) is the only
  // thing that places the Printful order, on checkout.session.completed.
  app.post("/checkout", async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
    const userId = await requireUser(req, res);
    if (!userId) return;
    const { designId, size, quantity, color } = req.body ?? {};
    if (!designId || typeof designId !== "string") {
      return res.status(400).json({ error: "designId (string) is required" });
    }
    const spec = await specs.get(designId);
    if (!spec) return res.status(404).json({ error: "design not found" });
    const qty = Math.max(1, Math.min(parseInt(String(quantity ?? "1"), 10) || 1, 10));
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            quantity: qty,
            price_data: {
              currency: "usd",
              unit_amount: config.priceUsdCents,
              product_data: {
                name: `Custom Tee${spec.color ? ` — ${spec.color}` : ""}`,
                description: (spec.prompt || "").slice(0, 220) || undefined,
                images: spec.previewImageUrl ? [spec.previewImageUrl] : [],
              },
            },
          },
        ],
        shipping_address_collection: { allowed_countries: ["US", "CA", "GB", "AU"] },
        metadata: {
          design_id: designId,
          size: typeof size === "string" && size ? size : "UNRESOLVED",
          quantity: String(qty),
          color: (typeof color === "string" && color) || spec.color || "",
        },
        success_url: `${config.checkoutBaseUrl}/checkout/success`,
        cancel_url: `${config.checkoutBaseUrl}/checkout/cancel`,
      });
      res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
      console.error("[checkout] failed:", err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/checkout/success", (_req, res) => res.type("html").send(checkoutPage(config.appScheme, true)));
  app.get("/checkout/cancel", (_req, res) => res.type("html").send(checkoutPage(config.appScheme, false)));

  app.get("/health", (_req, res) => res.json({ ok: true, brain: brain.constructor.name }));

  app.listen(config.port, () => {
    console.log(`threadbot-rebuild listening on :${config.port} (brain=${brain.constructor.name})`);
  });
}

/** Hosted page Stripe redirects to after checkout. Tries to bounce back into the app. */
function checkoutPage(scheme: string, ok: boolean): string {
  const deepLink = `${scheme}://checkout?status=${ok ? "success" : "cancel"}`;
  const title = ok ? "Payment complete" : "Checkout canceled";
  const body = ok
    ? "Your order is being sent to production. You can close this tab and return to Threadbot."
    : "No charge was made. Return to Threadbot and try again whenever you're ready.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Threadbot</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% -10%,#0c1622,#07080a 60%);color:#cfe9ee;font-family:system-ui,sans-serif;text-align:center;padding:24px}
h1{color:${ok ? "#19f0c4" : "#ff7b7b"};font-size:23px;letter-spacing:1px;margin:0 0 10px}p{opacity:.72;font-size:14px;max-width:330px;line-height:1.55;margin:0}a{margin-top:24px;color:#04181c;background:#00E5FF;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:700;letter-spacing:1px}</style></head>
<body><h1>${title}</h1><p>${body}</p><a href="${deepLink}">Return to Threadbot</a>
<script>setTimeout(function(){try{location.href=${JSON.stringify(deepLink)}}catch(e){}},700)</script></body></html>`;
}

function recipientFromSession(session: Stripe.Checkout.Session): Recipient {
  const d: any = (session as any).shipping_details ?? session.customer_details ?? {};
  const a = d.address ?? {};
  return {
    name: d.name ?? "Customer",
    address1: a.line1 ?? "",
    city: a.city ?? "",
    country_code: a.country ?? "US",
    state_code: a.state ?? undefined,
    zip: a.postal_code ?? "",
    email: session.customer_details?.email ?? undefined,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
