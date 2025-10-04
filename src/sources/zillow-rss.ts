import Parser from 'rss-parser';
import { Listing, ListingSource } from './types';

/**
 * Zillow RSS Feed Provider
 * 
 * Zillow provides public RSS feeds for listing searches.
 * This is a legal, publicly accessible feed provided by Zillow.
 * 
 * Note: You'll need to generate your own RSS feed URL from zillow.com
 * by performing a search and clicking the RSS icon.
 * 
 * Example feed URL format:
 * https://www.zillow.com/homes/for_sale/[location]/[filters]_rb/?rss=1
 */
export class ZillowRSSProvider implements ListingSource {
  readonly name = 'Zillow';
  private parser: Parser;
  private feedUrl: string;

  constructor(feedUrl?: string) {
    this.parser = new Parser({
      customFields: {
        item: [
          ['zillow:address', 'address'],
          ['zillow:city', 'city'],
          ['zillow:state', 'state'],
          ['zillow:zip', 'zip'],
          ['zillow:price', 'price'],
          ['zillow:bedrooms', 'beds'],
          ['zillow:bathrooms', 'baths'],
          ['zillow:sqft', 'sqft'],
          ['geo:lat', 'lat'],
          ['geo:long', 'lon'],
        ],
      },
    });

    // Default feed URL - this should be configured via environment variable
    // Users need to create their own search on Zillow and grab the RSS URL
    this.feedUrl = feedUrl || process.env.ZILLOW_RSS_URL || '';
  }

  async fetchListings(): Promise<Listing[]> {
    if (!this.feedUrl) {
      console.warn('⚠ Zillow RSS feed URL not configured. Skipping Zillow provider.');
      return [];
    }

    try {
      const feed = await this.parser.parseURL(this.feedUrl);
      const listings: Listing[] = [];

      for (const item of feed.items) {
        try {
          const listing = this.parseItem(item);
          if (listing) {
            listings.push(listing);
          }
        } catch (error) {
          console.error(`Failed to parse Zillow item: ${error}`);
        }
      }

      console.log(`✓ Fetched ${listings.length} listings from Zillow RSS`);
      return listings;
    } catch (error) {
      if (error instanceof Error) {
        console.error(`✗ Failed to fetch Zillow RSS feed: ${error.message}`);
      }
      return [];
    }
  }

  private parseItem(item: any): Listing | null {
    // Extract data from RSS item with fallbacks
    const link = item.link || item.guid;
    if (!link) {
      return null;
    }

    // Extract ID from URL
    const idMatch = link.match(/\/(\d+)_zpid/);
    const id = idMatch ? idMatch[1] : link;

    // Parse address components
    const address = item.address || this.extractFromDescription(item.description, 'address');
    const city = item.city || this.extractFromDescription(item.description, 'city');
    const state = item.state || this.extractFromDescription(item.description, 'state');
    const zip = item.zip || this.extractFromDescription(item.description, 'zip');

    // Parse price
    const priceStr = item.price || this.extractPrice(item.description || item.title);
    const price = this.parseNumber(priceStr);

    if (!price || !address) {
      return null;
    }

    // Parse optional fields
    const beds = item.beds ? this.parseNumber(item.beds) : undefined;
    const baths = item.baths ? this.parseNumber(item.baths) : undefined;
    const sqft = item.sqft ? this.parseNumber(item.sqft) : undefined;

    // Parse coordinates
    const lat = item.lat ? parseFloat(item.lat) : undefined;
    const lon = item.lon ? parseFloat(item.lon) : undefined;

    // Parse date
    const listedAt = item.pubDate ? new Date(item.pubDate) : new Date();

    return {
      id: `zillow-${id}`,
      url: link,
      address: address,
      city: city || 'Unknown',
      state: state || 'IL',
      zip: zip || '',
      lat,
      lon,
      price,
      beds,
      baths,
      sqft,
      source: this.name,
      listedAt,
    };
  }

  private extractPrice(text: string): string {
    const match = text.match(/\$[\d,]+/);
    return match ? match[0] : '';
  }

  private extractFromDescription(description: string | undefined, field: string): string {
    if (!description) return '';
    // Basic extraction logic - could be enhanced based on actual RSS format
    return '';
  }

  private parseNumber(value: any): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[$,]/g, '');
      const num = parseFloat(cleaned);
      return isNaN(num) ? undefined : num;
    }
    return undefined;
  }
}
