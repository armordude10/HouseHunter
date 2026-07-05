/**
 * Order-path verification: load the locked DesignSpec, build the real Printful order,
 * create a DRAFT, then CANCEL it. Proves fulfillment end-to-end with no Stripe, no
 * confirmation, no charge, and nothing left in the store.
 *
 *   node --import tsx scripts/verify-order.ts
 */

import { config } from "../src/config.js";
import { fulfillOrder } from "../src/core/fulfill.js";
import { SupabaseSpecStore, createSupabase } from "../src/core/supabaseStore.js";
import { PrintfulProvider } from "../src/providers/printful.js";

const sb = createSupabase(config.supabase.url, config.supabase.serviceRoleKey);
const specs = new SupabaseSpecStore(sb);
const provider = new PrintfulProvider(config.printful.apiKey, config.printful.storeId);

// Reuse the most recent preview so we don't spend on image generation again.
const { data, error } = await sb
  .from("design_specs")
  .select("id")
  .order("created_at", { ascending: false })
  .limit(1);
if (error) throw new Error(error.message);
const designId = data?.[0]?.id;
if (!designId) throw new Error("No design spec found — run scripts/verify-live.ts first.");
console.log("using design", designId);

const res = await fulfillOrder(
  { provider, specs },
  {
    designId,
    recipient: {
      name: "Doug Test",
      address1: "456 Main St",
      city: "Peoria",
      country_code: "US",
      state_code: "IL",
      zip: "61602",
      email: config.printful.storeId ? "doug@artincpeoria.org" : undefined,
    },
    size: "L",
    quantity: 1,
    externalId: `verify_draft_${Date.now()}`,
    confirm: false, // DRAFT ONLY — never confirmed, so never charged or fulfilled.
  }
);
console.log("fulfill (draft only):", res);

if (res.status === "drafted" && res.providerOrderId) {
  await provider.cancelOrder(res.providerOrderId);
  console.log(`cancelled draft ${res.providerOrderId} — nothing charged, nothing fulfilled.`);
} else {
  console.log("not drafted; nothing to cancel.");
}

console.log("\nORDER PATH VERIFY DONE");
