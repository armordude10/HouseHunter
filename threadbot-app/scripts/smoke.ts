/**
 * Offline end-to-end smoke: preview -> fulfill, plus the tamper guard.
 * Uses FakeBrain + a StubProvider (data-URI base image) so it needs no API keys.
 *   node --import tsx scripts/smoke.ts
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { CatalogProduct } from "../src/core/ai.js";
import { FakeBrain } from "../src/core/ai.js";
import { fulfillOrder } from "../src/core/fulfill.js";
import { generatePreview } from "../src/core/preview.js";
import { InMemorySpecStore, LocalImageStore } from "../src/core/store.js";
import { StaticCatalogRetriever } from "../src/core/retriever.js";
import type {
  CostEstimate,
  FulfillmentProvider,
  NeutralOrder,
  PlacementGeometry,
  ResolvedVariant,
} from "../src/providers/types.js";

class StubProvider implements FulfillmentProvider {
  readonly name = "printful";
  private baseDataUri = "";

  private async base(): Promise<string> {
    if (!this.baseDataUri) {
      const png = await sharp({
        create: { width: 1000, height: 1200, channels: 3, background: { r: 200, g: 200, b: 205 } },
      })
        .png()
        .toBuffer();
      this.baseDataUri = `data:image/png;base64,${png.toString("base64")}`;
    }
    return this.baseDataUri;
  }

  async resolveVariant(providerProductId: number | string, color: string, size?: string): Promise<ResolvedVariant> {
    return { providerProductId, providerVariantId: size ? 4017 : 4012, color, size: size ?? "M" };
  }
  async getPlacementGeometry(): Promise<PlacementGeometry> {
    return {
      placement: "front",
      technique: "dtg",
      baseImageUrl: await this.base(),
      templateWidth: 1000,
      templateHeight: 1200,
      printAreaWidth: 600,
      printAreaHeight: 800,
      printAreaTop: 100,
      printAreaLeft: 200,
    };
  }
  async resolveDecorationOptions() {
    return [];
  }
  async estimateCost(_order: NeutralOrder): Promise<CostEstimate> {
    return { subtotal: 10, shipping: 5, tax: 0, total: 15, currency: "USD" };
  }
  async createDraftOrder() {
    return "order_1";
  }
  async confirmOrder() {}
  async cancelOrder() {}
  async getProductTruth() {
    return { technique: "dtg", defaultColor: "Black", placements: ["front"] };
  }
  async getPanels() {
    return [{ placement: "front", width: 1800, height: 2400, dpi: 150 }];
  }
  async getPrintAreasV2() {
    return new Map<string, { width: number; height: number }>();
  }
  async findCatalogProduct() {
    return { id: 71, name: "Stub Tee" };
  }
  async getColors() {
    return [
      { name: "Black", hex: "#0b0b0b" },
      { name: "Navy", hex: "#1f2a44" },
      { name: "White", hex: "#ffffff" },
      { name: "Red", hex: "#b22222" },
    ];
  }
  async renderMockup() {
    return await this.base();
  }
  async checkAvailability() {
    return { inStock: true, discontinued: false };
  }
}

const catalog: CatalogProduct[] = JSON.parse(
  await readFile(join(process.cwd(), "data/catalog.json"), "utf8")
);
const specs = new InMemorySpecStore();
const images = new LocalImageStore(join(process.cwd(), "public"), "http://localhost:3000/public");
const provider = new StubProvider();
const brain = new FakeBrain();

const preview = await generatePreview(
  { brain, provider, specs, images, retriever: new StaticCatalogRetriever(catalog), providerName: "printful" },
  { prompt: "a neon fox in a misty forest, no text" }
);
assert.equal(preview.status, "ready");
assert.ok(preview.designId && preview.previewImageUrl);
console.log("preview:", preview);

const good = await fulfillOrder(
  { provider, specs },
  {
    designId: preview.designId!,
    recipient: { name: "Doug", address1: "1 St", city: "Peoria", country_code: "US", state_code: "IL", zip: "61602" },
    size: "L",
    quantity: 1,
    externalId: "sess_abc",
    chargedAmount: { amount: 29.99, currency: "USD" },
  }
);
assert.equal(good.status, "confirmed");
assert.equal(good.providerOrderId, "order_1");
console.log("fulfill (clean):", good);

// Tamper the stored spec after preview -> fulfillment must fail closed.
const stored = await specs.get(preview.designId!);
stored!.placements[0].position.left += 25;
const tampered = await fulfillOrder(
  { provider, specs },
  {
    designId: preview.designId!,
    recipient: { name: "Doug", address1: "1 St", city: "Peoria", country_code: "US", state_code: "IL", zip: "61602" },
    size: "L",
    externalId: "sess_def",
  }
);
assert.equal(tampered.status, "rejected");
console.log("fulfill (tampered):", tampered);

console.log("\nSMOKE OK");
