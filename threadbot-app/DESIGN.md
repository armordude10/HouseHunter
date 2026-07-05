# Threadbot rebuild — architecture

One messy (optionally multimodal) prompt in → a fast preview out → an **exact-match**
product fulfilled **only when an order is paid**. Supplier-agnostic; Printful is the
first adapter, not the architecture.

## Two phases, one contract

```
PHASE 1 — PREVIEW  (interactive, every prompt; cheap/fast)
  prompt (+image) ─┬─ policy/IP screen (on raw input) ─────────────┐
                   └─ understand + select product/variant ─────────┤  (1 multimodal call)
                                      │                             │
                                      ▼                             │
                          generate artwork (image gen) ◄────────────┘  (the long pole)
                                      ▼
                  deterministic composite onto provider base mockup
                  (print-area geometry = the mask)         ← no slow provider mockup task
                                      ▼
                  persist DesignSpec (hash-locked) + re-hosted preview image

PHASE 2 — FULFILLMENT  (fires ONLY on Stripe checkout.session.completed)
  load DesignSpec ─► re-assert exact-match hash (fail closed)
                 ─► bind late size → variant ─► availability + margin guard
                 ─► provider.createDraftOrder ─► provider.confirmOrder
```

The old flow ran ~13 sequential reasoning agents **and** a slow provider mockup task for
every browser. Here the interactive path is ~2–3 model calls + a millisecond composite,
and the heavy authoritative work runs only for paying customers.

## The exact-match guarantee

`preview == print` is enforced by data, not by a model trying to be faithful:

1. The **same** content-addressed art file (`fileUrl` + `fileSha256`) feeds the composite
   and the order.
2. The **same** `position` (`area_width/height, width, height, top, left`) feeds both. In
   Printful this object is byte-identical between the mockup-generator and order endpoints
   (verified in the Postman collection), and the composite math mirrors it
   (`src/core/position.ts`).
3. At preview we hash the **size-independent** design fingerprint and lock it on the spec
   (`src/core/hash.ts`). At fulfillment we recompute it from the spec we're about to submit
   and **refuse to confirm on mismatch** (`src/core/fulfill.ts`).

The fingerprint deliberately **excludes size and variant id**, so size can be bound late at
checkout without breaking the match (a t-shirt's front print geometry is identical across
sizes). Tests in `test/core.test.ts` pin all of this.

## Supplier abstraction (ports & adapters)

The core knows nothing about Printful. Providers implement one port
(`src/providers/types.ts` → `FulfillmentProvider`) and translate neutral shapes into their
own API. Swapping or adding a dropshipper — or moving to in-house fulfillment — means adding
a sibling adapter, not touching the core.

- Neutral catalog (`data/catalog.json`) maps your merchandised products → provider product ids.
- `getPlacementGeometry` is the only provider call on the preview path; the composite is core.
- The DesignSpec pins `provider + providerProductId + geometryVersion`, so an order is always
  fulfilled through the provider it was previewed on. Provider swaps apply to *new* designs;
  in-flight previews stay bound (or must be re-rendered) — that's what preserves exact-match
  across a swap.

### Keeping the supplier invisible
Composited previews are written to **your** bucket/domain (`ImageStore`), never served from
the provider CDN, so neither the supplier name nor its CDN host reaches the browser.

## Printful adapter — V1 routes used (from the Postman collection)

| Need | Route |
|---|---|
| Base mockup image + print-area geometry | `GET /mockup-generator/templates/{product_id}?technique=` |
| Resolve variant (color/size) + availability | `GET /products/{id}`, `GET /products/variant/{id}` |
| Authoritative price + margin guard | `POST /orders/estimate-costs` |
| Create draft order | `POST /orders` |
| Confirm for fulfillment | `POST /orders/{id}/confirm` |
| Embroidery thread colors (optional) | `POST /files/thread-colors` (or `auto_thread_color`) |

`auto_thread_color` / `thread-colors` replaces the old LLM "stitch color" guessing with a
deterministic, provider-backed answer.

> "Order placed" is **your Stripe event**, never a Printful event. Printful's webhooks
> (`package_shipped`, `stock_updated`) are downstream status that feed the adapter.

## Where the cost/speed went

- Product selection stays AI-driven (no UI picker) but is **one** understand+select call over
  a cached neutral catalog, not a multi-tool discovery dance.
- Static provider truth (geometry, variants, options) is cacheable per product.
- Preview renders the **hero placement only**; full multi-placement coverage is a
  fulfillment-time concern, not a preview cost.
- The slow provider mockup task is off the interactive path entirely.

## What's intentionally stubbed (swap for prod)

- `InMemorySpecStore` → Supabase Postgres; `LocalImageStore` → Supabase Storage / S3 + CDN.
- Catalog selection over a small JSON list → pgvector semantic retrieval over the cached
  catalog (same `Brain` seam).
- Policy/IP is a field on the understand call → attach your existing policy MCP at that seam.
- Stripe webhook awaits inline → enqueue a job, dedupe on `session.id` for idempotency.
