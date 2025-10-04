import { config } from './config';
import { geocodeZip, Coordinates } from './geo';
import { applyFilters } from './filters';
import { sendAlerts } from './sms';
import { generateListingHash, hasSeenListing, markListingAsSeen, getSeenCount } from './db';
import { getListingSources } from './sources';
import { Listing } from './sources/types';

let centerCoords: Coordinates | null = null;

/**
 * Main runner function - fetches, filters, dedupes, and sends alerts
 */
export async function run(): Promise<void> {
  try {
    console.log('\n🔍 Starting listing check...');
    
    // Geocode the target ZIP if not already done
    if (!centerCoords) {
      console.log(`Geocoding ZIP ${config.zip}...`);
      centerCoords = await geocodeZip(config.zip);
    }

    // Get all listing sources
    const sources = getListingSources();
    if (sources.length === 0) {
      console.log('⚠ No listing sources available');
      return;
    }

    // Fetch from all sources in parallel
    console.log(`Fetching from ${sources.length} source(s)...`);
    const fetchPromises = sources.map(async (source) => {
      try {
        return await source.fetchListings();
      } catch (error) {
        console.error(`✗ Error fetching from ${source.name}:`, error instanceof Error ? error.message : error);
        return [];
      }
    });

    const results = await Promise.allSettled(fetchPromises);
    const allListings = results
      .filter((r): r is PromiseFulfilledResult<Listing[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);

    console.log(`✓ Fetched ${allListings.length} total listing(s)`);

    if (allListings.length === 0) {
      console.log('No listings found');
      return;
    }

    // Apply filters
    console.log(`Filtering by price ($${config.minPrice}-$${config.maxPrice}) and radius (${config.radiusMiles}mi)...`);
    const filtered = applyFilters(
      allListings,
      centerCoords,
      config.radiusMiles,
      config.minPrice,
      config.maxPrice
    );

    console.log(`✓ ${filtered.length} listing(s) passed filters`);

    if (filtered.length === 0) {
      console.log('No listings match criteria');
      return;
    }

    // De-duplicate: filter out listings we've already seen
    const newListings: Listing[] = [];
    for (const listing of filtered) {
      const hash = generateListingHash(listing.source, listing.id, listing.url);
      
      if (!hasSeenListing(hash)) {
        newListings.push(listing);
        markListingAsSeen(hash, listing.id, listing.url, listing.address, listing.price);
      }
    }

    console.log(`✓ ${newListings.length} new listing(s) (${getSeenCount()} total seen)`);

    if (newListings.length === 0) {
      console.log('No new listings to alert on');
      return;
    }

    // Send SMS alerts
    console.log(`📱 Sending alerts for ${newListings.length} listing(s)...`);
    await sendAlerts(newListings);

    console.log('✓ Run complete\n');
  } catch (error) {
    console.error('✗ Error during run:', error instanceof Error ? error.message : error);
    // Don't re-throw - we want the cron to continue
  }
}
