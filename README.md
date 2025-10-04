# HomeAlert61611 🏠

A TypeScript/Node.js application that sends SMS alerts when new home listings appear within 25 miles of ZIP code 61611 (Illinois), priced between $70,000 and $230,000.

## Features

- 📍 **Geo-filtering**: Uses OpenStreetMap Nominatim for geocoding and Haversine distance calculation
- 💰 **Price filtering**: Configurable price range
- 🔄 **De-duplication**: Tracks seen listings in SQLite to avoid duplicate alerts
- 📱 **SMS Alerts**: Sends Twilio SMS to multiple recipients
- ⏱️ **Automated Polling**: Runs every 2 minutes (configurable)
- 🔌 **Pluggable Sources**: Easy-to-extend architecture for adding listing providers
- 🛡️ **Legal & Compliant**: Only uses publicly accessible feeds and APIs

## Setup

### Prerequisites

- Node.js 16+ and npm
- Twilio account with SMS capability
- Email address for Nominatim API identification

### Installation

1. Clone the repository:
```bash
git clone https://github.com/armordude10/HouseHunter.git
cd HouseHunter
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file from the example:
```bash
cp .env.example .env
```

4. Configure your `.env` file with required values:
   - **TWILIO_ACCOUNT_SID**: From [Twilio Console](https://www.twilio.com/console)
   - **TWILIO_AUTH_TOKEN**: From Twilio Console
   - **TWILIO_FROM**: Your Twilio phone number
   - **ALERT_RECIPIENTS**: Comma-separated phone numbers (E.164 format)
   - **NOMINATIM_EMAIL**: Your email (required by Nominatim usage policy)

### Running the Application

**Development mode** (with hot reload):
```bash
npm run dev
```

**Production mode**:
```bash
npm run build
npm start
```

**Run tests**:
```bash
npm test
```

## Configuration

All configuration is done via environment variables in `.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| TWILIO_ACCOUNT_SID | ✅ | - | Twilio account SID |
| TWILIO_AUTH_TOKEN | ✅ | - | Twilio auth token |
| TWILIO_FROM | ✅ | - | Twilio phone number |
| ALERT_RECIPIENTS | ✅ | - | Comma-separated recipient numbers |
| NOMINATIM_EMAIL | ✅ | - | Your email for Nominatim API |
| ZIP | ⬜ | 61611 | Target ZIP code |
| RADIUS_MI | ⬜ | 25 | Search radius in miles |
| MIN_PRICE | ⬜ | 70000 | Minimum listing price |
| MAX_PRICE | ⬜ | 230000 | Maximum listing price |
| POLL_MINUTES | ⬜ | 2 | Polling interval in minutes |
| ENABLE_STUB | ⬜ | false | Enable stub provider for testing |
| ZILLOW_RSS_URL | ⬜ | - | Zillow RSS feed URL |

## SMS Alert Format

Alerts are sent in this format:
```
NEW LISTING: $150,000 123 Main St, Peoria IL 61611 • 3bd/2ba • 1,500sqft • Zillow • https://...
```

## Adding a New Listing Provider

The application uses a pluggable architecture for listing sources. Here's how to add a new provider:

1. **Create a new file** in `src/sources/` (e.g., `src/sources/my-provider.ts`)

2. **Implement the `ListingSource` interface**:

```typescript
import { Listing, ListingSource } from './types';

export class MyProvider implements ListingSource {
  readonly name = 'MyProvider';

  async fetchListings(): Promise<Listing[]> {
    // Fetch data from your source
    const data = await fetchFromAPI();

    // Transform to normalized Listing format
    return data.map(item => ({
      id: item.id,
      url: item.url,
      address: item.address,
      city: item.city,
      state: item.state,
      zip: item.zip,
      lat: item.latitude,
      lon: item.longitude,
      price: item.price,
      beds: item.bedrooms,
      baths: item.bathrooms,
      sqft: item.squareFeet,
      source: this.name,
      listedAt: new Date(item.listedDate),
    }));
  }
}
```

3. **Register your provider** in `src/sources/index.ts`:

```typescript
import { MyProvider } from './my-provider';

export function getListingSources(): ListingSource[] {
  const sources: ListingSource[] = [];
  
  // Add your provider
  sources.push(new MyProvider());
  
  return sources;
}
```

4. **Add any required configuration** to `.env` and `src/config.ts`

### Example Providers

- **StubProvider** (`src/sources/stub.ts`): Returns sample data for testing
- **ZillowRSSProvider** (`src/sources/zillow-rss.ts`): Parses Zillow RSS feeds

## Legal & Terms of Service

⚠️ **Important**: This application is designed to use only publicly accessible and legally available data sources.

- **Nominatim**: Free for low-volume usage with proper attribution. See [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)
- **Zillow RSS**: Public RSS feeds are provided by Zillow for individual use. Respect their [Terms of Use](https://www.zillow.com/corp/Terms.htm)
- **DO NOT**:
  - Bypass paywalls or authentication
  - Scrape websites that prohibit it in their robots.txt
  - Exceed rate limits
  - Use data for commercial purposes without permission

Always review and comply with the Terms of Service of any data source you add.

## Project Structure

```
HouseHunter/
├── src/
│   ├── index.ts           # Application entry point with cron scheduling
│   ├── config.ts          # Environment configuration with zod validation
│   ├── runner.ts          # Main orchestration logic
│   ├── geo.ts             # Geocoding and Haversine distance
│   ├── filters.ts         # Price and radius filtering
│   ├── sms.ts             # Twilio SMS sending
│   ├── db.ts              # SQLite persistence for de-duplication
│   ├── sources/
│   │   ├── types.ts       # ListingSource interface and Listing type
│   │   ├── index.ts       # Source registration
│   │   ├── stub.ts        # Stub provider for testing
│   │   └── zillow-rss.ts  # Zillow RSS feed adapter
│   ├── geo.test.ts        # Haversine distance tests
│   ├── filters.test.ts    # Filtering logic tests
│   └── db.test.ts         # De-duplication tests
├── .env.example           # Environment configuration template
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── jest.config.js         # Jest test configuration
└── README.md              # This file
```

## Testing

The application includes unit tests for core functionality:

- **Haversine Distance**: Validates geographic distance calculations
- **Price Filtering**: Tests price range filtering logic
- **Radius Filtering**: Tests geographic radius filtering
- **De-duplication**: Tests listing hash generation and tracking

Run tests with:
```bash
npm test
```

## Troubleshooting

### "No listing sources configured"
- Set `ENABLE_STUB=true` for testing, or
- Configure `ZILLOW_RSS_URL` with a valid RSS feed

### "Configuration validation failed"
- Check that all required environment variables are set in `.env`
- Ensure phone numbers are in E.164 format (+13095551234)

### "Geocoding failed"
- Verify `NOMINATIM_EMAIL` is set to a valid email
- Check internet connection
- Wait and retry (Nominatim has rate limits)

### No SMS received
- Verify Twilio credentials are correct
- Check phone numbers are in correct format
- Verify Twilio account has SMS capability and credits
- Check Twilio console for error messages

## Development

### Adding Dependencies
```bash
npm install --save package-name
npm install --save-dev @types/package-name
```

### Building
```bash
npm run build
```

Output will be in the `dist/` directory.

### Debugging
Set `ENABLE_STUB=true` in `.env` to use the stub provider with sample data for testing the complete flow without real listing sources.

## License

ISC

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass: `npm test`
6. Submit a pull request

## Support

For issues or questions, please open an issue on GitHub.