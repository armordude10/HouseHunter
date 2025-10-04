import { haversineDistance, Coordinates } from './geo';

describe('Haversine Distance Calculation', () => {
  test('calculates distance between two coordinates correctly', () => {
    const peoria: Coordinates = { lat: 40.6936, lon: -89.5890 };
    const chicago: Coordinates = { lat: 41.8781, lon: -87.6298 };

    const distance = haversineDistance(peoria, chicago);

    // Distance between Peoria and Chicago is approximately 130 miles
    expect(distance).toBeGreaterThan(125);
    expect(distance).toBeLessThan(135);
  });

  test('calculates zero distance for same coordinates', () => {
    const coord: Coordinates = { lat: 40.6936, lon: -89.5890 };

    const distance = haversineDistance(coord, coord);

    expect(distance).toBe(0);
  });

  test('calculates distance for coordinates close together', () => {
    const coord1: Coordinates = { lat: 40.6936, lon: -89.5890 };
    const coord2: Coordinates = { lat: 40.6950, lon: -89.5900 }; // ~0.1 miles apart

    const distance = haversineDistance(coord1, coord2);

    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(1);
  });

  test('handles negative coordinates', () => {
    const coord1: Coordinates = { lat: -33.8688, lon: 151.2093 }; // Sydney
    const coord2: Coordinates = { lat: -37.8136, lon: 144.9631 }; // Melbourne

    const distance = haversineDistance(coord1, coord2);

    // Distance is approximately 440 miles
    expect(distance).toBeGreaterThan(430);
    expect(distance).toBeLessThan(450);
  });
});
