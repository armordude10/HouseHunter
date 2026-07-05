/**
 * Force IPv4-first egress. Containerized free hosts (e.g. Hugging Face Spaces)
 * frequently advertise IPv6 but have broken IPv6 egress, which surfaces as
 * undici "Premature close" on outbound HTTPS to OpenAI / Printful / Supabase —
 * the request connects, then the body is cut mid-stream. Resolving IPv4 first
 * and disabling Happy-Eyeballs auto-selection makes Node's built-in fetch use
 * the IPv4 path. Imported before anything makes a request.
 */
import { setDefaultResultOrder } from "node:dns";
import * as net from "node:net";

try {
  setDefaultResultOrder("ipv4first");
} catch {
  /* older runtime: ignore */
}
try {
  // Disable Happy Eyeballs so connections use the first (IPv4) address, not a race.
  (net as unknown as { setDefaultAutoSelectFamily?: (v: boolean) => void }).setDefaultAutoSelectFamily?.(false);
} catch {
  /* not available on this runtime: ignore */
}
