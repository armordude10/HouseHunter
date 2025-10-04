/**
 * Normalized listing structure
 */
export interface Listing {
  id: string;
  url: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat?: number;
  lon?: number;
  price: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  source: string;
  listedAt: Date;
}

/**
 * Interface for listing source adapters
 */
export interface ListingSource {
  /**
   * Unique identifier for this source
   */
  readonly name: string;

  /**
   * Fetch listings from this source
   */
  fetchListings(): Promise<Listing[]>;
}
