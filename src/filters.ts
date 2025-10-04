import { Listing } from './sources/types';
import { haversineDistance, Coordinates } from './geo';

/**
 * Filter listings by price range
 */
export function filterByPrice(
  listings: Listing[],
  minPrice: number,
  maxPrice: number
): Listing[] {
  return listings.filter(listing => {
    return listing.price >= minPrice && listing.price <= maxPrice;
  });
}

/**
 * Filter listings by distance from a center point
 */
export function filterByRadius(
  listings: Listing[],
  center: Coordinates,
  radiusMiles: number
): Listing[] {
  return listings.filter(listing => {
    // Skip listings without coordinates
    if (listing.lat === undefined || listing.lon === undefined) {
      return false;
    }

    const distance = haversineDistance(center, {
      lat: listing.lat,
      lon: listing.lon,
    });

    return distance <= radiusMiles;
  });
}

/**
 * Apply all filters to a list of listings
 */
export function applyFilters(
  listings: Listing[],
  center: Coordinates,
  radiusMiles: number,
  minPrice: number,
  maxPrice: number
): Listing[] {
  let filtered = filterByPrice(listings, minPrice, maxPrice);
  filtered = filterByRadius(filtered, center, radiusMiles);
  return filtered;
}
