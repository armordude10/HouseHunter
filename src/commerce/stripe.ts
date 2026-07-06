/**
 * Stripe checkout bridge — zero-dependency REST client.
 *
 * The pipeline creates a Stripe Checkout Session per purchase (dynamic
 * price_data: the REAL matched product's name, mockup image, and the
 * server-computed retail — never a static price) and receives
 * `checkout.session.completed` on /webhooks/stripe, which is the ONLY
 * trigger for Printful order placement (mirrors the original commerce
 * server's design).
 *
 * Configuration (Cloud Run env):
 *   STRIPE_SECRET_KEY       enables /checkout (restricted key: Checkout
 *                           Sessions write is all it needs)
 *   STRIPE_WEBHOOK_SECRET   signing secret for /webhooks/stripe
 *   THREADBOT_SHIPPING_FLAT_USD  flat shipping charged at checkout
 *                           (default 4.99; "0" ships free)
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API_BASE = process.env.STRIPE_API_BASE ?? "https://api.stripe.com";

export const stripeConfigured = (): boolean => Boolean(process.env.STRIPE_SECRET_KEY);

export const shippingFlatCents = (): number => {
  const usd = Number(process.env.THREADBOT_SHIPPING_FLAT_USD ?? "4.99");
  return Number.isFinite(usd) && usd >= 0 ? Math.round(usd * 100) : 499;
};

export interface CheckoutSessionParams {
  productName: string;
  description?: string;
  /** Publicly fetchable mockup image shown on the Stripe payment page. */
  imageUrl?: string;
  unitAmountCents: number;
  quantity: number;
  shippingCents: number;
  successUrl: string;
  cancelUrl: string;
  /** Flat string metadata; Stripe caps 50 keys / 500-char values. */
  metadata: Record<string, string>;
}

/**
 * Pure builder (unit-tested offline): Stripe's API is form-encoded with
 * bracketed nesting, not JSON.
 */
export const buildSessionForm = (params: CheckoutSessionParams): URLSearchParams => {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][quantity]", String(Math.max(1, Math.min(10, Math.round(params.quantity)))));
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(Math.max(50, Math.round(params.unitAmountCents))));
  form.set("line_items[0][price_data][product_data][name]", params.productName.slice(0, 120));
  if (params.description) {
    form.set("line_items[0][price_data][product_data][description]", params.description.slice(0, 220));
  }
  if (params.imageUrl && /^https:\/\//.test(params.imageUrl)) {
    form.set("line_items[0][price_data][product_data][images][0]", params.imageUrl);
  }
  ["US", "CA", "GB", "AU"].forEach((country, i) => {
    form.set(`shipping_address_collection[allowed_countries][${i}]`, country);
  });
  if (params.shippingCents > 0) {
    form.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    form.set("shipping_options[0][shipping_rate_data][display_name]", "Standard shipping");
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(Math.round(params.shippingCents)));
  }
  form.set("success_url", params.successUrl);
  form.set("cancel_url", params.cancelUrl);
  for (const [key, value] of Object.entries(params.metadata)) {
    if (!value) continue;
    form.set(`metadata[${key.slice(0, 40)}]`, value.slice(0, 500));
  }
  return form;
};

export const createCheckoutSession = async (
  params: CheckoutSessionParams
): Promise<{ id: string; url: string }> => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const response = await fetch(`${STRIPE_API_BASE}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: buildSessionForm(params).toString()
  });
  const data = (await response.json().catch(() => null)) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  } | null;
  if (!response.ok || !data?.id || !data?.url) {
    throw new Error(
      `stripe checkout session failed (HTTP ${response.status}): ${data?.error?.message ?? "no body"}`
    );
  }
  return { id: data.id, url: data.url };
};

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 * Scheme: header carries `t=<ts>,v1=<hmac>,...`; the signed payload is
 * `${t}.${rawBody}` with HMAC-SHA256 under the endpoint's signing secret.
 */
export const verifyStripeSignature = (
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean => {
  if (!header || !secret) return false;
  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return (parts.get("v1") ?? []).some((candidate) => {
    const candidateBuf = Buffer.from(candidate, "utf8");
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });
};

/** Test helper: produce a valid header for a payload (used by the suite). */
export const signStripePayload = (
  rawBody: string,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1000)
): string => {
  const hmac = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `t=${timestampSeconds},v1=${hmac}`;
};
