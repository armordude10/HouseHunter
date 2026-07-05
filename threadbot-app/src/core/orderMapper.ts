/**
 * Deterministic DesignSpec -> NeutralOrder mapping. No model, no provider, no I/O.
 *
 * The order's files/positions/options are copied verbatim from the spec placements,
 * so the bytes we submit are exactly the bytes we previewed and hashed.
 */

import type {
  DesignSpec,
  NeutralOrder,
  NeutralOrderItem,
  Recipient,
} from "./designSpec.js";

export interface BuildOrderArgs {
  spec: DesignSpec;
  recipient: Recipient;
  /** Variant id resolved for the (now-known) size at checkout. */
  boundVariantId: number | string;
  quantity: number;
  externalId: string;
  retailCosts?: Record<string, unknown>;
}

export function buildNeutralOrder(args: BuildOrderArgs): NeutralOrder {
  const { spec, recipient, boundVariantId, quantity, externalId, retailCosts } = args;

  const item: NeutralOrderItem = {
    providerVariantId: boundVariantId,
    quantity,
    files: spec.placements
      .filter((p) => p.mustRender)
      .map((p) => ({
        type: p.name,
        url: p.fileUrl,
        position: p.position,
        options: p.options,
      })),
    options: [],
  };

  return {
    externalId,
    recipient,
    items: [item],
    ...(retailCosts ? { retailCosts } : {}),
  };
}
