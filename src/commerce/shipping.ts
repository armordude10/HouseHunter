/**
 * Live supplier shipping quotes. The checkout page charges EXACTLY what the
 * supplier charges for the destination — flat guesses either eat margin or
 * gouge the customer. The customer picks a destination country in the app's
 * order sheet; the Stripe session then locks address collection to that
 * country so the quoted rate always matches the shipped rate.
 *
 * Supplier identity never leaks: rates surface as "Standard shipping".
 */

const PRINTFUL_API_BASE = process.env.PRINTFUL_API_BASE ?? "https://api.printful.com";

/** Destinations offered in the order sheet (Stripe page enforces the pick). */
export const SHIPPING_COUNTRIES = ["US", "CA", "GB", "AU"] as const;

export const normalizeShippingCountry = (raw: unknown): (typeof SHIPPING_COUNTRIES)[number] => {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return (SHIPPING_COUNTRIES as readonly string[]).includes(code)
    ? (code as (typeof SHIPPING_COUNTRIES)[number])
    : "US";
};

export interface ShippingQuote {
  cents: number;
  /** Customer-facing label (no supplier naming). */
  display_name: string;
}

/**
 * US/CA quotes demand a state/province (tax plumbing) but the returned
 * STANDARD rate is state-independent (verified live: CA=NY=KY), so a
 * representative state is safe and spares the customer a form field.
 */
const REPRESENTATIVE_STATE: Record<string, string> = { US: "CA", CA: "ON" };

export const buildShippingRequest = (variantId: number, quantity: number, countryCode: string) => ({
  recipient: {
    country_code: countryCode,
    ...(REPRESENTATIVE_STATE[countryCode] ? { state_code: REPRESENTATIVE_STATE[countryCode] } : {})
  },
  items: [{ variant_id: variantId, quantity: Math.max(1, Math.min(10, Math.round(quantity))) }],
  currency: "USD"
});

interface RawRate {
  id?: string;
  name?: string;
  rate?: string | number;
  minDeliveryDays?: number;
  maxDeliveryDays?: number;
}

/** Cheapest offered rate wins (that's the customer-default everywhere). */
export const pickCheapestRate = (rates: RawRate[]): ShippingQuote | null => {
  let best: { cents: number; min?: number; max?: number } | null = null;
  for (const rate of rates) {
    const usd = Number(rate.rate);
    if (!Number.isFinite(usd) || usd < 0) continue;
    const cents = Math.round(usd * 100);
    if (!best || cents < best.cents) {
      best = { cents, min: rate.minDeliveryDays, max: rate.maxDeliveryDays };
    }
  }
  if (!best) return null;
  const eta =
    best.min && best.max ? ` (${best.min}–${best.max} business days)` : best.max ? ` (up to ${best.max} business days)` : "";
  return { cents: best.cents, display_name: `Standard shipping${eta}` };
};

const QUOTE_TTL_MS = 60 * 60 * 1000;
const quoteCache = new Map<string, { quote: ShippingQuote; at: number }>();

export const quoteShipping = async (
  variantId: number,
  quantity: number,
  countryCode: string
): Promise<ShippingQuote | null> => {
  const key = `${variantId}:${quantity}:${countryCode}`;
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.at < QUOTE_TTL_MS) return cached.quote;
  const apiKey = process.env.PRINTFUL_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(`${PRINTFUL_API_BASE}/shipping/rates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.PRINTFUL_STORE_ID ? { "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID } : {})
      },
      body: JSON.stringify(buildShippingRequest(variantId, quantity, countryCode))
    });
    const data = (await response.json().catch(() => null)) as { result?: RawRate[] } | null;
    if (!response.ok || !Array.isArray(data?.result)) {
      console.error(`[shipping] quote HTTP ${response.status}: ${JSON.stringify(data)?.slice(0, 200)}`);
      return null;
    }
    const quote = pickCheapestRate(data.result);
    if (quote) quoteCache.set(key, { quote, at: Date.now() });
    return quote;
  } catch (error) {
    console.error(`[shipping] quote failed: ${(error as Error).message}`);
    return null;
  }
};
