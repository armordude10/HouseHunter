/**
 * Neutral domain types + the FulfillmentProvider port.
 *
 * Nothing in here knows about Printful. Providers (Printful today, others later,
 * in-house eventually) implement FulfillmentProvider and translate these neutral
 * shapes into their own API payloads. The core never imports a provider directly.
 *
 * This file is dependency-free on purpose so the deterministic core can import
 * its types without pulling zod/sharp/etc. into the hot path or the unit tests.
 */

export type Technique = "dtg" | "embroidery" | "aop" | "cut-sew" | (string & {});

/**
 * A design file's placement within a printfile coordinate space.
 * These fields are intentionally identical to Printful's `position` object, which
 * is shared byte-for-byte between the mockup-generator and order endpoints — that
 * shared shape is what makes "preview == print" provable rather than hopeful.
 */
export interface PrintPosition {
  area_width: number;
  area_height: number;
  width: number;
  height: number;
  top: number;
  left: number;
}

export interface FileOption {
  id: string;
  value: string | number | boolean;
}

export interface Placement {
  /** Neutral placement name, e.g. "front", "back", "left_sleeve". */
  name: string;
  technique: Technique;
  /** Public, immutable, content-addressed URL of the print-ready art. */
  fileUrl: string;
  /** sha256 of the art bytes. Half of the exact-match fingerprint. */
  fileSha256: string;
  /** Where the art sits in the printfile. The other half of the fingerprint. */
  position: PrintPosition;
  /** Decoration options (e.g. embroidery thread colors). [] for plain DTG. */
  options: FileOption[];
  mustRender: boolean;
}

export interface ProviderBinding {
  providerProductId: number | string;
  /** Encodes color + size, so it is NOT part of the size-independent fingerprint. */
  providerVariantId: number | string;
}

/**
 * The canonical, size-independent subset of a design that is hashed for the
 * exact-match guarantee. Deliberately excludes size, variant id, price and the
 * preview URL so size can be bound late (at checkout) without breaking the match.
 */
export interface DesignFingerprint {
  provider: string;
  providerProductId: number | string;
  color: string;
  placements: Array<{
    name: string;
    technique: string;
    fileUrl: string;
    fileSha256: string;
    position: PrintPosition;
    options: FileOption[];
  }>;
}

/** Geometry + base mockup image for one placement, returned by a provider. */
export interface PlacementGeometry {
  placement: string;
  technique: Technique;
  /** Blank product photo to composite onto (provider CDN; we re-host the result). */
  baseImageUrl: string;
  backgroundColor?: string;
  templateWidth: number;
  templateHeight: number;
  printAreaWidth: number;
  printAreaHeight: number;
  printAreaTop: number;
  printAreaLeft: number;
  printfileId?: number;
  dpi?: number;
}

export interface Recipient {
  name: string;
  address1: string;
  city: string;
  country_code: string;
  state_code?: string;
  zip: string;
  email?: string;
  phone?: string;
}

export interface NeutralOrderFile {
  type: string; // placement name
  url: string;
  position: PrintPosition;
  options: FileOption[];
}

export interface NeutralOrderItem {
  providerVariantId: number | string;
  quantity: number;
  files: NeutralOrderFile[];
  options: FileOption[];
}

export interface NeutralOrder {
  externalId: string;
  recipient: Recipient;
  items: NeutralOrderItem[];
  retailCosts?: Record<string, unknown>;
}

export interface CostEstimate {
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  currency: string;
}

export interface ResolvedVariant {
  providerProductId: number | string;
  providerVariantId: number | string;
  color: string;
  size: string;
}

/**
 * The port. A provider is swappable as long as it can answer these.
 * Preview compositing lives in the core; the provider only supplies geometry.
 */
export interface FulfillmentProvider {
  readonly name: string;

  /** Resolve a concrete sellable variant. `size` omitted -> representative variant for the color. */
  resolveVariant(
    providerProductId: number | string,
    color: string,
    size?: string
  ): Promise<ResolvedVariant>;

  /** Base mockup image + print-area geometry for one placement. */
  getPlacementGeometry(
    providerProductId: number | string,
    providerVariantId: number | string,
    placement: string,
    technique: Technique
  ): Promise<PlacementGeometry>;

  /** Decoration options for a placement (e.g. resolve embroidery thread colors). */
  resolveDecorationOptions(
    placement: string,
    technique: Technique,
    fileUrl: string
  ): Promise<FileOption[]>;

  estimateCost(order: NeutralOrder): Promise<CostEstimate>;

  /** Create a DRAFT order (not yet sent to production). Returns provider order id. */
  createDraftOrder(order: NeutralOrder): Promise<string>;

  /** Confirm a draft for fulfillment. */
  confirmOrder(providerOrderId: string): Promise<void>;

  /** Cancel/delete an order (e.g. a draft created for a dry run, or a refund). */
  cancelOrder(providerOrderId: string): Promise<void>;

  checkAvailability(
    providerVariantId: number | string
  ): Promise<{ inStock: boolean; discontinued: boolean }>;

  /** Default technique, a representative color, and valid placements for a product. */
  getProductTruth(
    productId: number | string
  ): Promise<{ technique: string; defaultColor: string; placements: string[] }>;

  /** Panels (placements) of a product with their printfile dimensions. */
  getPanels(
    productId: number | string,
    technique: string,
    variantId?: number | string
  ): Promise<Array<{ placement: string; width: number; height: number; dpi: number }>>;

  /** Real per-placement print-area (pixels) used to shape panel art so each panel fills. */
  getPrintAreasV2(
    productId: number | string,
    placements: string[]
  ): Promise<Map<string, { width: number; height: number }>>;

  /** Resolve a catalog product by a name/model substring (locks the system to one product). */
  findCatalogProduct(query: string): Promise<{ id: number; name: string } | null>;

  /** Available garment colours (name + hex) for intelligent colour selection. */
  getColors(productId: number | string): Promise<Array<{ name: string; hex: string }>>;

  /** Render a REAL provider mockup across one or more panels; returns an image URL. */
  renderMockup(args: {
    productId: number | string;
    variantId: number | string;
    technique?: string;
    files: Array<{ placement: string; fileUrl: string; position: PrintPosition; dpi?: number }>;
  }): Promise<string>;
}
