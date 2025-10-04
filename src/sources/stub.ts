import { Listing, ListingSource } from './types';

/**
 * Stub provider for testing - generates fake listings
 * This demonstrates the ListingSource interface implementation
 */
export class StubProvider implements ListingSource {
  readonly name = 'StubProvider';

  async fetchListings(): Promise<Listing[]> {
    // Return empty array in production, or sample data for testing
    // This is just to demonstrate the interface
    const now = new Date();
    
    return [
      {
        id: 'stub-001',
        url: 'https://example.com/listing/stub-001',
        address: '123 Main St',
        city: 'Peoria',
        state: 'IL',
        zip: '61611',
        lat: 40.6936,
        lon: -89.5890,
        price: 150000,
        beds: 3,
        baths: 2,
        sqft: 1500,
        source: this.name,
        listedAt: now,
      },
    ];
  }
}
