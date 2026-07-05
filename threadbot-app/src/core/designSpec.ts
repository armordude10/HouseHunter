/**
 * The DesignSpec — the single contract that produced the preview and will produce
 * the order. Zod lives here (the boundary), so the pure core modules don't pull it in.
 *
 * Re-exports the neutral provider types so the rest of the core has one import surface.
 */

import { z } from "zod";

export * from "../providers/types.js";

export const UNRESOLVED_SIZE = "UNRESOLVED" as const;

const PrintPositionSchema = z.object({
  area_width: z.number(),
  area_height: z.number(),
  width: z.number(),
  height: z.number(),
  top: z.number(),
  left: z.number(),
});

const FileOptionSchema = z.object({
  id: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const PlacementSchema = z.object({
  name: z.string(),
  technique: z.string(),
  fileUrl: z.string().url(),
  fileSha256: z.string(),
  position: PrintPositionSchema,
  options: z.array(FileOptionSchema),
  mustRender: z.boolean(),
});

export const DesignSpecSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  prompt: z.string(),
  hasImageInput: z.boolean(),

  provider: z.string(),
  neutralProductId: z.string(),
  providerBinding: z.object({
    providerProductId: z.union([z.number(), z.string()]),
    providerVariantId: z.union([z.number(), z.string()]),
  }),

  color: z.string(),
  /** "UNRESOLVED" until the customer picks a size at checkout. */
  size: z.string(),

  placements: z.array(PlacementSchema).min(1),

  geometryVersion: z.string(),
  previewImageUrl: z.string(),
  price: z.object({ amount: z.number(), currency: z.string() }).optional(),
  policy: z.object({
    status: z.enum(["allow", "review", "block"]),
    reason: z.string().optional(),
  }),

  /** sha256 over the size-independent fingerprint. The exact-match lock. */
  orderHash: z.string(),
});

export type DesignSpec = z.infer<typeof DesignSpecSchema>;
