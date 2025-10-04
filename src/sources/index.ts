import { ListingSource } from './types';
import { StubProvider } from './stub';
import { ZillowRSSProvider } from './zillow-rss';

/**
 * Get all enabled listing sources
 */
export function getListingSources(): ListingSource[] {
  const sources: ListingSource[] = [];

  // Always include stub for testing
  // Comment out in production
  if (process.env.ENABLE_STUB === 'true') {
    sources.push(new StubProvider());
  }

  // Add Zillow RSS if configured
  if (process.env.ZILLOW_RSS_URL) {
    sources.push(new ZillowRSSProvider(process.env.ZILLOW_RSS_URL));
  }

  // Add more sources here as they're implemented
  // sources.push(new AnotherProvider());

  if (sources.length === 0) {
    console.warn('⚠ No listing sources configured!');
    console.warn('  Set ZILLOW_RSS_URL or ENABLE_STUB=true in .env');
  }

  return sources;
}
