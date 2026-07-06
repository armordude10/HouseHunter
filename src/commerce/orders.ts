/**
 * Design-order registry + Printful order placement.
 *
 * Every completed /generate run registers the order-relevant truth (matched
 * product, resolved variant, print-res panel files, product options) keyed
 * by run_id. The app's Buy button sends `designId` = `${run_id}-${i}`; the
 * registry resolves it back to the run. On `checkout.session.completed`
 * the pipeline places the Printful order from the SAME print files the
 * mockups were rendered from — what the customer saw is what gets printed.
 *
 * Orders are created as DRAFTS by default (review them in the Printful
 * dashboard; nothing is charged/produced until confirmed). Set
 * THREADBOT_ORDER_CONFIRM=1 to auto-confirm for production.
 */

const PRINTFUL_API_BASE = process.env.PRINTFUL_API_BASE ?? "https://api.printful.com";

export interface DesignOrderRecord {
  run_id: string;
  product_id: number;
  variant_id: number;
  product_name: string;
  retail_usd: number;
  mockup_url: string | null;
  placements: Array<{ placement: string; technique: string; file_url: string }>;
  product_options?: Record<string, string>;
  created_at: number;
}

const REGISTRY_TTL_MS = 7 * 24 * 3600 * 1000;
const REGISTRY_MAX = 2000;
const registry = new Map<string, DesignOrderRecord>();

export const registerDesign = (record: DesignOrderRecord): void => {
  registry.set(record.run_id, record);
  if (registry.size > REGISTRY_MAX) {
    const oldest = registry.keys().next().value;
    if (oldest) registry.delete(oldest);
  }
};

/** Accepts a bare run_id or the app's variation id `${run_id}-${i}`. */
export const getDesign = (designId: string): DesignOrderRecord | null => {
  const direct = registry.get(designId);
  const record = direct ?? registry.get(designId.replace(/-\d{1,2}$/, ""));
  if (!record) return null;
  if (Date.now() - record.created_at > REGISTRY_TTL_MS) {
    registry.delete(record.run_id);
    return null;
  }
  return record;
};

export const designRegistrySize = (): number => registry.size;

export interface OrderRecipient {
  name: string;
  address1: string;
  address2?: string;
  city: string;
  state_code?: string;
  country_code: string;
  zip: string;
  email?: string;
}

export interface PlaceOrderParams {
  record: DesignOrderRecord;
  /** Final catalog variant (size/color-resolved at checkout time). */
  catalogVariantId: number;
  quantity: number;
  recipient: OrderRecipient;
  /** Stripe session id — Printful-side idempotency/traceability. */
  externalId: string;
  retailPerItemUsd: number;
  confirm: boolean;
}

/** Pure builder (unit-tested offline): Printful v2 order body. */
export const buildOrderPayload = (params: PlaceOrderParams) => ({
  external_id: params.externalId.slice(0, 32),
  recipient: {
    name: params.recipient.name.slice(0, 100),
    address1: params.recipient.address1,
    ...(params.recipient.address2 ? { address2: params.recipient.address2 } : {}),
    city: params.recipient.city,
    ...(params.recipient.state_code ? { state_code: params.recipient.state_code } : {}),
    country_code: params.recipient.country_code,
    zip: params.recipient.zip,
    ...(params.recipient.email ? { email: params.recipient.email } : {})
  },
  order_items: [
    {
      source: "catalog",
      catalog_variant_id: params.catalogVariantId,
      quantity: Math.max(1, Math.min(10, Math.round(params.quantity))),
      retail_price: params.retailPerItemUsd.toFixed(2),
      name: params.record.product_name.slice(0, 120),
      placements: params.record.placements.map((p) => ({
        placement: p.placement,
        technique: p.technique,
        layers: [{ type: "file", url: p.file_url }]
      })),
      ...(params.record.product_options && Object.keys(params.record.product_options).length
        ? {
            product_options: Object.entries(params.record.product_options).map(([name, value]) => ({
              name,
              value
            }))
          }
        : {})
    }
  ]
});

const printfulHeaders = () => {
  const key = process.env.PRINTFUL_API_KEY;
  if (!key) throw new Error("PRINTFUL_API_KEY is not set");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    ...(process.env.PRINTFUL_STORE_ID ? { "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID } : {})
  };
};

export const placePrintfulOrder = async (
  params: PlaceOrderParams
): Promise<{ order_id: number; status: string; confirmed: boolean }> => {
  const response = await fetch(`${PRINTFUL_API_BASE}/v2/orders`, {
    method: "POST",
    headers: printfulHeaders(),
    body: JSON.stringify(buildOrderPayload(params))
  });
  const created = (await response.json().catch(() => null)) as {
    data?: { id?: number; status?: string };
    error?: { message?: string };
    errors?: unknown[];
  } | null;
  if (!response.ok || !created?.data?.id) {
    throw new Error(
      `printful order create failed (HTTP ${response.status}): ${JSON.stringify(created)?.slice(0, 500)}`
    );
  }
  const orderId = created.data.id;
  let status = created.data.status ?? "draft";
  let confirmed = false;
  if (params.confirm) {
    const confirmResponse = await fetch(`${PRINTFUL_API_BASE}/v2/orders/${orderId}/confirmation`, {
      method: "POST",
      headers: printfulHeaders()
    });
    const confirmedBody = (await confirmResponse.json().catch(() => null)) as {
      data?: { status?: string };
    } | null;
    if (confirmResponse.ok) {
      confirmed = true;
      status = confirmedBody?.data?.status ?? status;
    } else {
      // Draft still exists — surface loudly, don't lose the order.
      console.error(
        `[orders] confirmation failed for order ${orderId} (HTTP ${confirmResponse.status}); draft preserved`
      );
    }
  }
  return { order_id: orderId, status, confirmed };
};
