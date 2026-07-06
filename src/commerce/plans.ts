/**
 * Subscription tiers + server-side usage metering.
 *
 * Economics: each generation costs ~$0.05–0.15 of AI spend; product sales
 * carry their own margin. Tiers price the GENERATION budget so free users
 * can't drain API spend, while every paid tier is profitable on its own
 * even before a single product sale:
 *
 *   free  $0        5 gen/mo   (max exposure ~$0.75/user/mo)
 *   pro   $7.99    60 gen/mo   (worst-case AI cost ~$9 — but P50 ~$3–4;
 *                               overage protection is the hard cap itself)
 *   max   $19.99  200 gen/mo
 *   team  $59.99  1000 gen/mo  (pooled; commercial use)
 *
 * Metering is tamper-proof without giving the backend a database credential:
 * usage rows are INSERTed with the CALLER's bearer token into a table whose
 * RLS allows insert+select-own only — no update/delete policies exist, so a
 * user cannot erase their own count.
 *
 * Plan resolution order:
 *   1. THREADBOT_UNLIMITED_USERS (comma-sep emails/user ids — admin/testing)
 *   2. THREADBOT_PLAN_OVERRIDES  (JSON {"email":"pro",...} — manual comps)
 *   3. Stripe subscription lookup by the JWT's email (requires the restricted
 *      key to have Customers:Read + Subscriptions:Read; degrades to free
 *      silently until those permissions are granted)
 *   4. free
 */

const SUPABASE_URL = () =>
  process.env.THREADBOT_SUPABASE_URL ?? "https://dwexqosfijipthndmtvf.supabase.co";
const SUPABASE_KEY = () => process.env.THREADBOT_SUPABASE_KEY ?? "";
const STRIPE_API_BASE = process.env.STRIPE_API_BASE ?? "https://api.stripe.com";

export interface PlanSpec {
  id: "free" | "pro" | "max" | "team" | "unlimited";
  label: string;
  generationsPerMonth: number;
  closetSlots: number;
  priceUsdMonthly: number;
}

export const PLANS: Record<string, PlanSpec> = {
  free: { id: "free", label: "Free", generationsPerMonth: 5, closetSlots: 5, priceUsdMonthly: 0 },
  pro: { id: "pro", label: "Pro", generationsPerMonth: 60, closetSlots: 50, priceUsdMonthly: 7.99 },
  max: { id: "max", label: "Max", generationsPerMonth: 200, closetSlots: 200, priceUsdMonthly: 19.99 },
  team: { id: "team", label: "Team", generationsPerMonth: 1000, closetSlots: 1000, priceUsdMonthly: 59.99 },
  unlimited: {
    id: "unlimited",
    label: "Unlimited",
    generationsPerMonth: Number.MAX_SAFE_INTEGER,
    closetSlots: Number.MAX_SAFE_INTEGER,
    priceUsdMonthly: 0
  }
};

/** Decode email + sub from a Supabase JWT without verification (the token
 *  was already accepted by RLS-backed calls; this is only for plan lookup). */
export const decodeJwtClaims = (bearer: string): { email?: string; sub?: string } => {
  try {
    const payload = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString("utf8"));
    return { email: payload.email, sub: payload.sub };
  } catch {
    return {};
  }
};

const restHeaders = (bearer: string) => ({
  apikey: SUPABASE_KEY(),
  Authorization: `Bearer ${bearer}`,
  "Content-Type": "application/json"
});

/** Generations recorded for this caller in the current calendar month. */
export const monthlyUsage = async (bearer: string): Promise<number | null> => {
  if (!SUPABASE_KEY()) return null;
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const response = await fetch(
      `${SUPABASE_URL()}/rest/v1/usage_events?select=id&kind=eq.generation&created_at=gte.${monthStart.toISOString()}`,
      { headers: { ...restHeaders(bearer), Prefer: "count=exact", Range: "0-0" } }
    );
    if (!response.ok) return null;
    const range = response.headers.get("content-range"); // e.g. "0-0/7"
    const total = Number(range?.split("/")[1]);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
};

/** Record one paid generation against the caller (their own RLS row). */
export const recordUsage = async (bearer: string): Promise<void> => {
  if (!SUPABASE_KEY()) return;
  try {
    await fetch(`${SUPABASE_URL()}/rest/v1/usage_events`, {
      method: "POST",
      headers: restHeaders(bearer),
      body: JSON.stringify({ kind: "generation" })
    });
  } catch {
    /* metering must never break a run */
  }
};

const planCache = new Map<string, { plan: PlanSpec; at: number }>();
const PLAN_TTL_MS = 10 * 60 * 1000;

const stripePlanForEmail = async (email: string): Promise<PlanSpec | null> => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const custResponse = await fetch(
      `${STRIPE_API_BASE}/v1/customers?email=${encodeURIComponent(email)}&limit=3`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!custResponse.ok) return null; // restricted key lacks Customers:Read — degrade
    const customers = (await custResponse.json()) as { data?: Array<{ id: string }> };
    for (const customer of customers.data ?? []) {
      const subResponse = await fetch(
        `${STRIPE_API_BASE}/v1/subscriptions?customer=${customer.id}&status=active&limit=5`,
        { headers: { Authorization: `Bearer ${key}` } }
      );
      if (!subResponse.ok) return null;
      const subs = (await subResponse.json()) as {
        data?: Array<{
          metadata?: { plan?: string };
          items?: { data?: Array<{ price?: { metadata?: { plan?: string } } }> } }>;
      };
      for (const sub of subs.data ?? []) {
        const subPlan = sub.metadata?.plan;
        if (subPlan && PLANS[subPlan]) return PLANS[subPlan];
        for (const item of sub.items?.data ?? []) {
          const plan = item.price?.metadata?.plan;
          if (plan && PLANS[plan]) return PLANS[plan];
        }
      }
    }
    return null;
  } catch {
    return null;
  }
};

export const resolvePlan = async (bearer: string): Promise<PlanSpec> => {
  const { email, sub } = decodeJwtClaims(bearer);
  const identity = (email ?? sub ?? "").toLowerCase();
  if (!identity) return PLANS.free;
  const cached = planCache.get(identity);
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.plan;

  const unlimited = (process.env.THREADBOT_UNLIMITED_USERS ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let plan: PlanSpec | null = null;
  if (unlimited.includes(identity) || (sub && unlimited.includes(sub.toLowerCase()))) {
    plan = PLANS.unlimited;
  }
  if (!plan) {
    try {
      const overrides = JSON.parse(process.env.THREADBOT_PLAN_OVERRIDES ?? "{}") as Record<string, string>;
      const override = overrides[identity];
      if (override && PLANS[override]) plan = PLANS[override];
    } catch {
      /* bad override JSON — ignore */
    }
  }
  if (!plan && email) plan = await stripePlanForEmail(email);
  const resolved = plan ?? PLANS.free;
  planCache.set(identity, { plan: resolved, at: Date.now() });
  return resolved;
};

/** Friendly refusal used when the monthly budget is exhausted. */
export const quotaMessage = (plan: PlanSpec): string =>
  plan.id === "free"
    ? `You've used all ${plan.generationsPerMonth} free designs this month. Upgrade to keep creating — Pro ($7.99/mo, 60 designs), Max ($19.99/mo, 200), or Team ($59.99/mo, 1000).`
    : `You've reached your ${plan.label} plan's ${plan.generationsPerMonth} designs this month. Your budget resets on the 1st, or upgrade for more.`;
