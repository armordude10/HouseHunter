/**
 * In-process public image hosting, shared by the HTTP server (customer
 * uploads) and the OpenAI media adapter (generated panels).
 *
 * Files are served at GET /uploads/:id by src/server.ts. THREADBOT_PUBLIC_URL
 * must point at this service's public base URL for adapter-hosted files to be
 * reachable by Printful/OpenAI; per-request bases are used for customer
 * uploads. Same durability class as run records (min-instances >= 1); move to
 * bucket storage together with the SQL run store.
 */

import { randomUUID } from "node:crypto";

export interface HostedImage {
  bytes: Buffer;
  contentType: string;
  at: number;
}

export const hostedImages = new Map<string, HostedImage>();

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 400_000_000;

export const pruneHostedImages = () => {
  const now = Date.now();
  let total = 0;
  for (const record of hostedImages.values()) total += record.bytes.length;
  for (const [id, record] of hostedImages) {
    if (now - record.at > TTL_MS || total > MAX_TOTAL_BYTES) {
      total -= record.bytes.length;
      hostedImages.delete(id);
    }
  }
};

// ---------------------------------------------------------------------------
// Durable mirror: every hosted file is ALSO written to Supabase Storage
// (public 'runfiles' bucket) so a deploy/restart can never orphan a file that
// Printful is about to fetch — the live root cause of every AOP-hoodie mockup
// timeout (long runs straddled deploys; the new instance 404'd the panels).
// Memory stays the hot path; the bucket is the safety net GET /uploads
// falls back to (and re-caches from) on a miss.
// ---------------------------------------------------------------------------

const SUPABASE_URL = () =>
  process.env.THREADBOT_SUPABASE_URL ?? "https://dwexqosfijipthndmtvf.supabase.co";
const SUPABASE_KEY = () => process.env.THREADBOT_SUPABASE_KEY ?? "";

const persistDurable = async (id: string, record: HostedImage): Promise<void> => {
  if (!SUPABASE_KEY()) return;
  try {
    const response = await fetch(`${SUPABASE_URL()}/storage/v1/object/runfiles/${id}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY(),
        Authorization: `Bearer ${SUPABASE_KEY()}`,
        "Content-Type": record.contentType,
        "x-upsert": "true"
      },
      body: new Uint8Array(record.bytes)
    });
    if (!response.ok) {
      console.warn(`[hosting] durable mirror failed for ${id}: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(`[hosting] durable mirror failed for ${id}: ${(error as Error).message}`);
  }
};

/** Restart-surviving fallback: pull a missed file back from the bucket. */
export const fetchDurableImage = async (id: string): Promise<HostedImage | null> => {
  if (!SUPABASE_KEY() || !/^[a-f0-9-]{36}$/.test(id)) return null;
  try {
    const response = await fetch(`${SUPABASE_URL()}/storage/v1/object/public/runfiles/${id}`);
    if (!response.ok) return null;
    const record: HostedImage = {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "image/png",
      at: Date.now()
    };
    hostedImages.set(id, record); // re-warm the hot path
    return record;
  } catch {
    return null;
  }
};

export const putHostedImage = (bytes: Buffer, contentType = "image/png"): string => {
  const id = randomUUID();
  const record = { bytes, contentType, at: Date.now() };
  hostedImages.set(id, record);
  void persistDurable(id, record);
  pruneHostedImages();
  return id;
};

/** Absolute URL for a hosted image (adapter path: requires the env base). */
export const hostedImageUrl = (id: string): string => {
  const base = process.env.THREADBOT_PUBLIC_URL;
  if (!base) {
    throw new Error(
      "THREADBOT_PUBLIC_URL is not set — required to host generated panels at a public URL"
    );
  }
  return `${base.replace(/\/+$/, "")}/uploads/${id}`;
};
