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

export const putHostedImage = (bytes: Buffer, contentType = "image/png"): string => {
  const id = randomUUID();
  hostedImages.set(id, { bytes, contentType, at: Date.now() });
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
