/**
 * PHASE 2 — Fulfillment. Fires ONLY from the paid-order trigger (Stripe webhook).
 *
 * No model, no creative work. Loads the locked DesignSpec, binds the late size,
 * re-asserts the exact-match fingerprint (fail closed), then drafts + confirms the
 * order through whichever provider the design was previewed on.
 */

import type { FulfillmentProvider, Recipient } from "../providers/types.js";
import { computeOrderHash } from "./hash.js";
import { buildNeutralOrder } from "./orderMapper.js";
import type { SpecStore } from "./store.js";

export interface FulfillDeps {
  provider: FulfillmentProvider;
  specs: SpecStore;
}

export interface FulfillRequest {
  designId: string;
  recipient: Recipient;
  /** Size chosen at checkout (or a stored default). May be "UNRESOLVED" -> representative. */
  size: string;
  quantity?: number;
  externalId: string;
  /** false = create the provider draft but do NOT confirm it (dry run / review-before-send). */
  confirm?: boolean;
  /** What the customer was actually charged, for margin protection. */
  chargedAmount?: { amount: number; currency: string };
}

export interface FulfillResult {
  status: "confirmed" | "drafted" | "rejected";
  providerOrderId?: string;
  reason?: string;
}

export async function fulfillOrder(deps: FulfillDeps, req: FulfillRequest): Promise<FulfillResult> {
  const spec = await deps.specs.get(req.designId);
  if (!spec) return { status: "rejected", reason: `Unknown design ${req.designId}` };

  // (1) Integrity: the stored spec must still hash to its locked value. If a row was
  // tampered with after preview (art swapped, position moved), refuse to print it.
  const recomputed = computeOrderHash({
    provider: spec.provider,
    providerBinding: { providerProductId: spec.providerBinding.providerProductId },
    color: spec.color,
    placements: spec.placements,
  });
  if (recomputed !== spec.orderHash) {
    return { status: "rejected", reason: "Design fingerprint mismatch — not fulfilling." };
  }

  // (2) Bind the late size to a concrete variant (same product + color).
  const concreteSize = req.size && req.size !== "UNRESOLVED" ? req.size : undefined;
  const variant = await deps.provider.resolveVariant(
    spec.providerBinding.providerProductId,
    spec.color,
    concreteSize
  );

  const availability = await deps.provider.checkAvailability(variant.providerVariantId);
  if (availability.discontinued || !availability.inStock) {
    return { status: "rejected", reason: "Selected variant is unavailable." };
  }

  // (3) Map verbatim from the spec — same files, positions, options that were previewed.
  const order = buildNeutralOrder({
    spec,
    recipient: req.recipient,
    boundVariantId: variant.providerVariantId,
    quantity: req.quantity ?? 1,
    externalId: req.externalId,
  });

  // (4) Margin guard.
  if (req.chargedAmount) {
    const estimate = await deps.provider.estimateCost(order);
    if (estimate.total > req.chargedAmount.amount) {
      return {
        status: "rejected",
        reason: `Provider cost ${estimate.total} ${estimate.currency} exceeds charged ${req.chargedAmount.amount} ${req.chargedAmount.currency}.`,
      };
    }
  }

  // (5) Draft -> confirm.
  const providerOrderId = await deps.provider.createDraftOrder(order);

  if (req.confirm === false) {
    return { status: "drafted", providerOrderId };
  }

  await deps.provider.confirmOrder(providerOrderId);
  return { status: "confirmed", providerOrderId };
}
