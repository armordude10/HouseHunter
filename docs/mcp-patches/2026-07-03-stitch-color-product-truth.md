# threadbot-printful-mockups-mcp: stitch_color product-truth safety net

**Deployed:** 2026-07-03, Cloud Run revision `threadbot-printful-mockups-mcp-00012-6qc`,
image tag `stitch-truth-fix-20260703` (patch layer appended to `:latest`; original
preserved in-image as `dist/index.js.bak-stitch-color-product-truth-20260703-204500`).

## Problem

The mockup payload safety net injected `stitch_color` based on a placement-name
heuristic (`>1 placement`, or names containing sleeve/hood/pocket). Products with
no `product_options` (shoes #657, and most non-apparel) matched the heuristic and
Printful rejected the task:

```
400 Invalid `product_options` provided: `stitch_color`,
    no `product_options` available for this product
```

## Fix (in `dist/index.js`)

1. New `productSupportsStitchColor(productId)`: `GET /v2/catalog-products/{id}`
   via the existing `printfulFetch` helper, checks `data.product_options[].name`
   for `stitch_color`, result cached in-memory per product.
2. `applyMockupPayloadSafetyNet` is now `async` and truth-gated:
   - product supports stitch_color and it's missing → inject (unchanged inference)
   - product does NOT support it but caller supplied it → **strip it** (inverse bug)
   - truth lookup fails → fall back to the original heuristic (unchanged resilience)
3. Both call sites in `createPrintfulMockupTaskWithSafetyNet` now `await` it.
   The provider-error retry path is untouched.

## Verified in production

- Shoes #657, 2 placements, no options: `status=completed`, `safety_net_repairs=[]`
  (previously hard 400)
- Hoodie #388, no options passed: `status=completed`,
  `repairs=[{"name":"stitch_color","value":"black","reason":"preflight_aop_panel_payload"}]`
  (behavior preserved)

## To absorb into the service's source repo

Apply the same three changes to `src/index.ts` (the deployed patch was made to
the compiled `dist/index.js`, consistent with prior in-image patches). Diff
essence:

```diff
+const productStitchColorSupportCache = new Map();
+async function productSupportsStitchColor(productId) {
+    const key = String(productId ?? "");
+    if (!key) return null;
+    if (productStitchColorSupportCache.has(key)) return productStitchColorSupportCache.get(key);
+    try {
+        const detail = await printfulFetch(`/v2/catalog-products/${encodeURIComponent(key)}`);
+        const options = Array.isArray(detail?.data?.product_options) ? detail.data.product_options : [];
+        const supported = options.some((option) => option && option.name === "stitch_color");
+        productStitchColorSupportCache.set(key, supported);
+        return supported;
+    } catch { return null; }
+}
-function applyMockupPayloadSafetyNet(args, reason = "preflight") {
+async function applyMockupPayloadSafetyNet(args, reason = "preflight") {
     ...
     const added = [];
+    const supportsStitchColor = await productSupportsStitchColor(repaired.product_id);
+    if (supportsStitchColor === false && hasProductOption(repaired.product_options, "stitch_color")) {
+        repaired.product_options = repaired.product_options.filter((option) => option.name !== "stitch_color");
+        added.push({ name: "stitch_color", value: null, reason: `${reason}_removed_unsupported_option` });
+    }
     const missingStitchColor =
         !hasProductOption(repaired.product_options, "stitch_color") &&
-            mockupPayloadLooksLikeAopPanelProduct(repaired);
+            (supportsStitchColor === true ||
+                (supportsStitchColor === null && mockupPayloadLooksLikeAopPanelProduct(repaired)));
-    const preflight = applyMockupPayloadSafetyNet(args, "preflight_aop_panel_payload");
+    const preflight = await applyMockupPayloadSafetyNet(args, "preflight_aop_panel_payload");
-        const retry = applyMockupPayloadSafetyNet({
+        const retry = await applyMockupPayloadSafetyNet({
```

## Rollback

`gcloud run services update threadbot-printful-mockups-mcp --region us-central1 \
  --image us-central1-docker.pkg.dev/threadbot-mcp-prod/threadbot-mcp/threadbot-printful-mockups-mcp:latest`
