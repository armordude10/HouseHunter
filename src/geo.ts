import axios from 'axios';
import { config } from './config';

export interface Coordinates {
  lat: number;
  lon: number;
}

let cachedZipCoords: Coordinates | null = null;

/**
 * Geocode a ZIP code using OpenStreetMap Nominatim API
 */
export async function geocodeZip(zip: string): Promise<Coordinates> {
  if (cachedZipCoords) {
    return cachedZipCoords;
  }

  const userAgent = `HomeAlert61611/1.0 (${config.nominatimEmail})`;
  
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        postalcode: zip,
        country: 'us',
        format: 'json',
        limit: 1,
      },
      headers: {
        'User-Agent': userAgent,
      },
      timeout: 10000,
    });

    if (response.data && response.data.length > 0) {
      const result = response.data[0];
      cachedZipCoords = {
        lat: parseFloat(result.lat),
        lon: parseFloat(result.lon),
      };
      console.log(`✓ Geocoded ZIP ${zip} to lat=${cachedZipCoords.lat}, lon=${cachedZipCoords.lon}`);
      return cachedZipCoords;
    }

    throw new Error(`No results found for ZIP ${zip}`);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`Geocoding failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Calculate the distance between two coordinates using the Haversine formula
 * Returns distance in miles
 */
export function haversineDistance(
  coord1: Coordinates,
  coord2: Coordinates
): number {
  const R = 3959; // Earth's radius in miles
  const dLat = toRadians(coord2.lat - coord1.lat);
  const dLon = toRadians(coord2.lon - coord1.lon);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(coord1.lat)) *
      Math.cos(toRadians(coord2.lat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Add a delay for rate limiting (e.g., for Nominatim)
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
