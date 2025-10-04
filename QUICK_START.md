# Quick Start Guide

## Getting Started in 5 Minutes

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Environment Variables

Copy the example environment file:
```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:
- Get Twilio credentials from https://www.twilio.com/console
- Add your phone numbers in E.164 format (+13095550123)
- Use your real email for NOMINATIM_EMAIL

### 3. Test with Stub Provider

For a quick test without real listing sources, enable the stub provider:

```bash
# Add to your .env file:
ENABLE_STUB=true
```

This will return sample listings to test the full flow.

### 4. Run the Application

```bash
# Development mode (with hot reload)
npm run dev

# Or build and run in production mode
npm run build
npm start
```

### 5. Add a Real Listing Source

#### Option 1: Zillow RSS Feed

1. Go to [Zillow.com](https://www.zillow.com)
2. Search for homes with your criteria (location, price, etc.)
3. Look for the RSS feed link in the search results, or add `&rss=1` to the URL
4. Copy the RSS URL and add to your `.env`:
   ```
   ZILLOW_RSS_URL=https://www.zillow.com/homes/...&rss=1
   ```

#### Option 2: Add Your Own Provider

See the README section "Adding a New Listing Provider" for details on implementing the `ListingSource` interface.

## Running Tests

```bash
npm test
```

Tests verify:
- ✅ Haversine distance calculations
- ✅ Price range filtering
- ✅ Geographic radius filtering  
- ✅ Listing de-duplication logic

## Troubleshooting

### No listings found?
- Check that at least one source is configured (ENABLE_STUB=true or ZILLOW_RSS_URL)
- Verify your RSS URL is valid
- Check console logs for errors

### SMS not sending?
- Verify Twilio credentials are correct
- Ensure phone numbers are in E.164 format
- Check you have Twilio credits
- Review Twilio console for delivery status

### Geocoding errors?
- Ensure NOMINATIM_EMAIL is set to a valid email
- Wait between requests (Nominatim has rate limits)
- Check your internet connection

## What Happens When Running?

1. **On Startup**: Geocodes ZIP 61611 to coordinates
2. **Every Poll Interval** (default 2 minutes):
   - Fetches listings from all configured sources
   - Filters by price ($70k-$230k) and distance (25 miles)
   - Checks database for duplicates
   - Sends SMS for any new listings
3. **Database**: Tracks seen listings in `seen_listings.db`

## Configuration Options

All settings are in `.env`:
- **Location**: `ZIP`, `RADIUS_MI`
- **Price Range**: `MIN_PRICE`, `MAX_PRICE`
- **Polling**: `POLL_MINUTES` (how often to check)
- **Sources**: `ENABLE_STUB`, `ZILLOW_RSS_URL`, etc.

## Next Steps

- Add more listing sources by implementing the `ListingSource` interface
- Customize SMS message format in `src/sms.ts`
- Adjust filters in `src/filters.ts`
- Configure different polling intervals for different sources

Happy house hunting! 🏠
