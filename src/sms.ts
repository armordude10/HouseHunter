import twilio from 'twilio';
import { config } from './config';
import { Listing } from './sources/types';

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

/**
 * Format a listing for SMS message
 */
export function formatListingMessage(listing: Listing): string {
  const parts = [
    `NEW LISTING: $${listing.price.toLocaleString()}`,
    `${listing.address}, ${listing.city} ${listing.state} ${listing.zip}`,
  ];

  const details: string[] = [];
  if (listing.beds !== undefined) {
    details.push(`${listing.beds}bd`);
  }
  if (listing.baths !== undefined) {
    details.push(`${listing.baths}ba`);
  }
  if (listing.sqft !== undefined) {
    details.push(`${listing.sqft.toLocaleString()}sqft`);
  }

  if (details.length > 0) {
    parts.push(`• ${details.join('/')}`);
  }

  parts.push(`• ${listing.source}`);
  parts.push(`• ${listing.url}`);

  return parts.join(' ');
}

/**
 * Send SMS alert to all recipients
 */
export async function sendAlert(listing: Listing): Promise<void> {
  const message = formatListingMessage(listing);

  const sendPromises = config.alertRecipients.map(async (to) => {
    try {
      await client.messages.create({
        body: message,
        from: config.twilio.from,
        to: to,
      });
      console.log(`✓ SMS sent to ${to}`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`✗ Failed to send SMS to ${to}: ${error.message}`);
      } else {
        console.error(`✗ Failed to send SMS to ${to}`);
      }
    }
  });

  await Promise.allSettled(sendPromises);
}

/**
 * Send SMS alerts for multiple listings
 */
export async function sendAlerts(listings: Listing[]): Promise<void> {
  for (const listing of listings) {
    await sendAlert(listing);
    // Small delay between messages to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
