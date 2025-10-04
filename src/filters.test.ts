import { filterByPrice, filterByRadius } from './filters';
import { Listing } from './sources/types';
import { Coordinates } from './geo';

const createMockListing = (overrides: Partial<Listing>): Listing => ({
  id: 'test-1',
  url: 'https://example.com/1',
  address: '123 Main St',
  city: 'Peoria',
  state: 'IL',
  zip: '61611',
  lat: 40.6936,
  lon: -89.5890,
  price: 150000,
  source: 'Test',
  listedAt: new Date(),
  ...overrides,
});

describe('Price Filtering', () => {
  test('includes listings within price range', () => {
    const listings: Listing[] = [
      createMockListing({ id: '1', price: 100000 }),
      createMockListing({ id: '2', price: 150000 }),
      createMockListing({ id: '3', price: 200000 }),
    ];

    const filtered = filterByPrice(listings, 90000, 210000);

    expect(filtered).toHaveLength(3);
  });

  test('excludes listings below minimum price', () => {
    const listings: Listing[] = [
      createMockListing({ id: '1', price: 50000 }),
      createMockListing({ id: '2', price: 100000 }),
    ];

    const filtered = filterByPrice(listings, 70000, 200000);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].price).toBe(100000);
  });

  test('excludes listings above maximum price', () => {
    const listings: Listing[] = [
      createMockListing({ id: '1', price: 150000 }),
      createMockListing({ id: '2', price: 250000 }),
    ];

    const filtered = filterByPrice(listings, 70000, 200000);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].price).toBe(150000);
  });

  test('includes listings at exact boundaries', () => {
    const listings: Listing[] = [
      createMockListing({ id: '1', price: 70000 }),
      createMockListing({ id: '2', price: 230000 }),
    ];

    const filtered = filterByPrice(listings, 70000, 230000);

    expect(filtered).toHaveLength(2);
  });
});

describe('Radius Filtering', () => {
  const center: Coordinates = { lat: 40.6936, lon: -89.5890 }; // Peoria

  test('includes listings within radius', () => {
    const listings: Listing[] = [
      createMockListing({ id: '1', lat: 40.6936, lon: -89.5890 }), // Same location
      createMockListing({ id: '2', lat: 40.7, lon: -89.6 }), // Close by
    ];

    const filtered = filterByRadius(listings, center, 25);

    expect(filtered.length).toBeGreaterThan(0);
  });

  test('excludes listings outside radius', () => {
    const listings: Listing[] = [
      createMockListing({ id: '1', lat: 40.6936, lon: -89.5890 }), // Same location
      createMockListing({ id: '2', lat: 41.8781, lon: -87.6298 }), // Chicago (~140 miles)
    ];

    const filtered = filterByRadius(listings, center, 25);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('1');
  });

  test('excludes listings without coordinates', () => {
    const listings: Listing[] = [
      createMockListing({ id: '1', lat: undefined, lon: undefined }),
      createMockListing({ id: '2', lat: 40.6936, lon: -89.5890 }),
    ];

    const filtered = filterByRadius(listings, center, 25);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('2');
  });
});
