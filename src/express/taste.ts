/**
 * Per-user taste curation: learn what a customer leans toward from their
 * completed runs, and feed it back as SOFT hints when a prompt leaves
 * details unspecified.
 *
 * Security model: all reads/writes go through Supabase REST using the
 * CALLER'S OWN access token (the app already sends it as the Authorization
 * bearer), so row-level security scopes everything to that user — the
 * backend holds no privileged database credential at all.
 *
 * The hint is explicitly bracketed and the intent instructions treat it as
 * non-authoritative: it fills gaps, it never overrides the request.
 */

import { ExpressIntent } from "./intent.js";

const SUPABASE_URL = () =>
  process.env.THREADBOT_SUPABASE_URL ?? "https://dwexqosfijipthndmtvf.supabase.co";
const SUPABASE_KEY = () => process.env.THREADBOT_SUPABASE_KEY ?? "";

export interface TasteProfile {
  styles?: Record<string, number>;
  palettes?: Record<string, number>;
  products?: Record<string, number>;
  colors?: Record<string, number>;
  recent?: string[];
}

/** A JWT has two dots; the publishable key is not a user token. */
export const looksLikeUserToken = (bearer: string | undefined): bearer is string =>
  typeof bearer === "string" && bearer.split(".").length === 3;

export const decodeUserId = (bearer: string): string | null => {
  try {
    const payload = JSON.parse(
      Buffer.from(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8"
      )
    ) as { sub?: string };
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
};

const restHeaders = (bearer: string) => ({
  apikey: SUPABASE_KEY(),
  Authorization: `Bearer ${bearer}`,
  "Content-Type": "application/json"
});

export const fetchTaste = async (bearer: string): Promise<{ profile: TasteProfile; runs: number } | null> => {
  if (!SUPABASE_KEY()) return null;
  try {
    const response = await fetch(`${SUPABASE_URL()}/rest/v1/user_taste?select=profile,runs`, {
      headers: restHeaders(bearer)
    });
    if (!response.ok) return null;
    const rows = (await response.json()) as Array<{ profile?: TasteProfile; runs?: number }>;
    if (!rows.length) return null;
    return { profile: rows[0].profile ?? {}, runs: rows[0].runs ?? 0 };
  } catch {
    return null;
  }
};

const topKeys = (counts: Record<string, number> | undefined, n: number): string[] =>
  Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);

/** Human-readable soft-hint line, or null when there's nothing worth saying. */
export const tasteHintLine = (taste: { profile: TasteProfile; runs: number } | null): string | null => {
  if (!taste || taste.runs < 2) return null; // don't infer from a single run
  const styles = topKeys(taste.profile.styles, 4);
  const palettes = topKeys(taste.profile.palettes, 3);
  const colors = topKeys(taste.profile.colors, 2);
  // Product history is deliberately EXCLUDED: hinting "typical products"
  // steered the intent's product_query over an explicit ask (live incident:
  // "dark blue shirt with this logo" -> sports bra, because the account had
  // just made one). Taste may color the art, never choose the product.
  const parts = [
    styles.length ? `styles they gravitate to: ${styles.join(", ")}` : "",
    palettes.length ? `palettes: ${palettes.join(", ")}` : "",
    colors.length ? `garment colors: ${colors.join(", ")}` : ""
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
};

const bump = (counts: Record<string, number>, key: string) => {
  const k = key.toLowerCase().trim().slice(0, 40);
  if (!k) return;
  counts[k] = (counts[k] ?? 0) + 1;
};

const cap = (counts: Record<string, number>, n = 16): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n));

/** Fire-and-forget after a completed run; failures never affect the run. */
export const updateTaste = async (
  bearer: string,
  userId: string,
  intent: ExpressIntent,
  productName: string,
  previous: { profile: TasteProfile; runs: number } | null
): Promise<void> => {
  if (!SUPABASE_KEY()) return;
  try {
    const profile: TasteProfile = {
      styles: { ...(previous?.profile.styles ?? {}) },
      palettes: { ...(previous?.profile.palettes ?? {}) },
      products: { ...(previous?.profile.products ?? {}) },
      colors: { ...(previous?.profile.colors ?? {}) },
      recent: [...(previous?.profile.recent ?? [])]
    };
    for (const term of intent.style_terms.slice(0, 6)) bump(profile.styles!, term);
    for (const term of intent.palette.slice(0, 6)) bump(profile.palettes!, term);
    if (intent.garment_color) bump(profile.colors!, intent.garment_color);
    bump(profile.products!, productName.split("|")[0].trim());
    profile.styles = cap(profile.styles!);
    profile.palettes = cap(profile.palettes!);
    profile.products = cap(profile.products!, 10);
    profile.colors = cap(profile.colors!, 8);
    profile.recent = [intent.artwork_brief.slice(0, 80), ...profile.recent!].slice(0, 5);

    await fetch(`${SUPABASE_URL()}/rest/v1/user_taste`, {
      method: "POST",
      headers: { ...restHeaders(bearer), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: userId,
        profile,
        runs: (previous?.runs ?? 0) + 1,
        updated_at: new Date().toISOString()
      })
    });
  } catch {
    // advisory system: never let taste bookkeeping touch the run
  }
};
