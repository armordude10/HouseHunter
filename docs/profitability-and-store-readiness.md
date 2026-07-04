# Threadbot: Profitability Shape & Dual-Store Readiness

_2026-07-04. Companion to the express path (`src/express/`), which is the
engineering half of this plan._

## 1. The governing constraint

Threadbot sells ~$15–$100 physical products. Every run's AI cost is a direct
deduction from a thin print-on-demand margin, and most runs will NOT convert
to a sale — so per-run cost must be priced like a marketing cost, not a COGS
line. Rule of thumb adopted:

> **AI cost per design run ≤ 2% of the product's retail price, and cheap
> enough that ~10 non-converting runs per sale still leaves margin.**

The 13-agent pipeline on frontier models measured ~$5/run (≈33% of a $15 tee,
before a single image). That is structurally unprofitable. The fix is not a
cheaper model on the same architecture — it's removing the model from every
decision that code can make.

## 2. Express path economics (now the default `/runs` mode)

Per run, worst case (6-panel AOP hoodie, no reference images):

| Item | Count | Est. cost |
|---|---|---|
| Intent + policy (light model, structured) | 1 | ~$0.003 |
| Reference image captions (light vision) | 0–10 | ~$0.002 ea |
| Master image generation | 1 | ~$0.03 |
| Per-panel upscales (hosting path) | ≤6 | ~$0.002 ea |
| Product truth (Printful catalog reads) | cached | $0 |
| Surface plan, slicing, seams, stitch color | code | $0 |
| Official Printful mockups | free API | $0 |
| Customer message | template | $0 |
| **Total** | | **≈ $0.04–0.07** |

Verified offline by `npm run expresscheck`: a full hoodie run is exactly
1 structured LLM call + 1 image generation; a refused run is exactly 0 paid
calls; a mockup failure preserves paid artwork for a $0 retry.

Margin anchors per hero product (see `src/express/catalog.ts`):

| Product | Base (est.) | Retail (sugg.) | Gross margin | AI cost as % of retail |
|---|---|---|---|---|
| Bella 3001 tee (71) | $9.25 | $24.99 | ~$15.6 | ~0.2% |
| AOP crew tee (257) | $17.50 | $36.99 | ~$19.4 | ~0.15% |
| AOP hoodie (388) | $41.50 | $69.99 | ~$28.4 | ~0.1% |
| AOP leggings (242) | $26.50 | $54.99 | ~$28.4 | ~0.1% |
| AOP shoes (657) | $49.00 | $89.99 | ~$40.9 | ~0.08% |

At $0.05/run, **one sale absorbs ~300 non-converting runs** on a hoodie.
The unit economics now fail only if free usage is unbounded — hence tiering.

## 3. Product tiers

- **Express (default)** — the flow above. This is the free/cheap tier users
  burn on; it is also good enough to be the paid path for most requests.
- **Agents (premium / fallback)** — `POST /runs {"mode":"agents"}` runs the
  original 13-node pipeline (frozen instructions untouched) for complex
  multi-constraint briefs, catalog-wide discovery, verified pricing. Gate it
  behind a paid tier or spend it only when express output is rejected.
  Runner now enforces `THREADBOT_LLM_CALL_BUDGET` (default 200 calls) so a
  runaway run fails loudly at bounded cost.

Suggested app pricing (validate in-store):
- 3 free express designs (lifetime or /month) → conversion hook
- Design credits: ~$2.99 / 10 express designs (≥90% margin on credits alone)
- Premium design (agents mode): 1 credit bundle or subscription perk
- Product purchase always includes the design cost — never charge twice.

## 4. Cost & abuse guards now in code

- Regex IP/abuse pre-gate refuses obvious trademark/hate requests at $0.
- Intent call carries policy; refusal exits before any image spend.
- Non-AOP products plan the primary placement only (extra DTG placements are
  fulfillment cost, not free coverage).
- 40-job plan cap, 4MB plan cap, 10-image cap, 1MB body cap (pre-existing).
- Per-run economics telemetry in every express result + `llm_usage` on every
  run record: cost regressions show up per run, not per invoice.

## 5. Store readiness (Google Play + Apple App Store)

Blocking items, in dependency order:

1. **iOS app does not exist.** The client is an APK (separate branch
   `claude/keen-feynman-if31ao`, not in this repo). Fastest path to both
   stores: rebuild the thin client in Flutter/React Native or wrap the
   existing UI; the backend contract is already mobile-shaped
   (`POST /runs` → poll `GET /runs/:id`).
2. **Accounts + payments.** Store review requires working purchases:
   in-app purchase for credits (Google Play Billing / StoreKit), NOT direct
   card entry for digital credits (Apple 3.1.1). Physical product checkout
   may use external payment (Stripe) — physical goods are exempt from IAP.
3. **UGC / AI-content policy surface** (both stores now require):
   - visible content policy + in-app report mechanism for generated designs
   - the policy gate above documented in the review notes
   - age rating questionnaire: mark AI-generated content features.
4. **Privacy**: privacy policy URL, data-safety forms (both stores), delete-
   account path if accounts exist. Uploaded reference images must have a
   stated retention policy.
5. **IP claims process**: a DMCA-style takedown contact for designs that slip
   the gate — Printful will also enforce on their side; surface that cleanly
   instead of failing silently at fulfillment.
6. **Operational**: pin the pipeline service to min-instances 1 (in-memory
   run store), move run records to SQL/Firestore before scale, rotate the
   keys that were shared in chat, move OPENAI key back to Secret Manager.

## 6. What was deliberately NOT changed

The 13 frozen agent instructions and Zod schemas (`src/instructions.ts`,
`src/schemas.ts`) are byte-identical. The express path is a separate entry
point that reuses the proven engine underneath (Panel Compiler, calibration
data, garment-space math, official-Printful mockup client).
