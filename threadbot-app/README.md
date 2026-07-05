# threadbot-rebuild

Supplier-agnostic design + commerce core. **One messy prompt → fast exact-match preview →
fulfillment only when the order is paid.** Printful is the first fulfillment adapter, hidden
from the customer and swappable.

See [`DESIGN.md`](./DESIGN.md) for the architecture and the exact-match guarantee.

## Quick start

```bash
npm install
cp .env.example .env        # fill in keys (works key-less in fake mode too)
npm test                    # exact-match core (9 tests, no keys needed)
node --import tsx scripts/smoke.ts   # offline preview -> fulfill -> tamper-guard
npm run dev                 # start the server
```

With no `OPENAI_API_KEY` the server runs with `FakeBrain` (default product + a solid
placeholder artwork) so the full deterministic pipeline is exercisable without spend.

## Endpoints

```http
POST /preview
{ "prompt": "a neon fox in a misty forest, no text", "imageUrls": [], "defaultSize": "M" }
→ { "status": "ready", "designId": "...", "previewImageUrl": "...", "product": "Classic Tee", "color": "Black" }

POST /webhooks/stripe        # checkout.session.completed -> fulfillOrder(...)
GET  /health
```

### Wiring the order trigger
When you create the Stripe Checkout Session, set:

```js
metadata: { design_id: "<designId from /preview>", size: "L", quantity: "1" }
```

`size` is bound here at checkout (the preview's hash excludes size, so this is safe). On
`checkout.session.completed` the webhook loads the spec, re-asserts the exact-match hash,
checks availability + margin, then drafts and confirms the provider order.

## Layout

```
src/
  core/
    designSpec.ts   # the contract (zod) + neutral type re-exports
    hash.ts         # canonical fingerprint + order hash (size-independent)   [pure]
    position.ts     # print-area geometry math (preview == order)             [pure]
    orderMapper.ts  # DesignSpec -> NeutralOrder, verbatim                    [pure]
    composite.ts    # sharp: art -> provider base mockup (the preview)
    ai.ts           # Brain: understand+select + artwork (OpenAIBrain / FakeBrain)
    store.ts        # SpecStore + ImageStore (in-memory / local; Supabase-ready)
    preview.ts      # PHASE 1
    fulfill.ts      # PHASE 2 (Stripe-triggered)
  providers/
    types.ts        # FulfillmentProvider port + neutral domain types
    printful.ts     # Printful V1 adapter (routes from the Postman collection)
  server.ts         # /preview + /webhooks/stripe
data/catalog.json   # neutral catalog -> provider product bindings (seed; verify ids)
test/core.test.ts   # exact-match guarantees
scripts/smoke.ts    # offline end-to-end
```

## Scaling: Supabase + pgvector (built in)

Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (+ optional `SUPABASE_BUCKET`) and the
server switches from in-memory/local-disk to Supabase automatically: specs in Postgres,
preview/art images in Storage, and product selection via pgvector semantic retrieval.
With no Supabase env set it falls back to in-memory + local disk + a static catalog, so the
app still runs key-lessly.

```bash
# 1. apply schema (design_specs + catalog_products + match_catalog_products + pgvector)
#    via the Supabase MCP, the dashboard SQL editor, or the CLI:
supabase db push          # or run supabase/migrations/0001_init.sql
# 2. create a public Storage bucket named `previews` (or set SUPABASE_BUCKET)
# 3. embed the catalog into pgvector
node --import tsx scripts/sync-catalog.ts
```

## Remaining production swaps

- Policy field on the understand call → your existing hosted policy/IP MCP.
- Inline webhook → queued job, idempotent on `session.id`.
- Image fusion for prompts with uploaded images → `images.edit` (the `Brain.generateArtwork` seam).
- Verify the seed Printful product ids in `data/catalog.json` against your store.
