import { generateListingHash, hasSeenListing, markListingAsSeen } from './db';

describe('De-duplication Logic', () => {
  test('generateListingHash creates consistent hashes', () => {
    const hash1 = generateListingHash('Zillow', '123', 'https://example.com/listing');
    const hash2 = generateListingHash('Zillow', '123', 'https://example.com/listing');

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 produces 64 hex characters
  });

  test('generateListingHash normalizes URLs', () => {
    const hash1 = generateListingHash('Zillow', '123', 'https://example.com/listing/');
    const hash2 = generateListingHash('Zillow', '123', 'http://example.com/listing');

    expect(hash1).toBe(hash2);
  });

  test('generateListingHash creates different hashes for different listings', () => {
    const hash1 = generateListingHash('Zillow', '123', 'https://example.com/listing1');
    const hash2 = generateListingHash('Zillow', '456', 'https://example.com/listing2');

    expect(hash1).not.toBe(hash2);
  });

  test('hasSeenListing returns false for new listing', () => {
    const hash = generateListingHash('Test', `new-${Date.now()}`, 'https://test.com/new');

    expect(hasSeenListing(hash)).toBe(false);
  });

  test('hasSeenListing returns true after marking as seen', () => {
    const uniqueId = `test-${Date.now()}`;
    const hash = generateListingHash('Test', uniqueId, `https://test.com/${uniqueId}`);

    expect(hasSeenListing(hash)).toBe(false);

    markListingAsSeen(hash, uniqueId, `https://test.com/${uniqueId}`, '123 Test St', 150000);

    expect(hasSeenListing(hash)).toBe(true);
  });

  test('markListingAsSeen handles duplicate inserts gracefully', () => {
    const uniqueId = `test-dup-${Date.now()}`;
    const hash = generateListingHash('Test', uniqueId, `https://test.com/${uniqueId}`);

    // Insert the same listing twice
    markListingAsSeen(hash, uniqueId, `https://test.com/${uniqueId}`, '123 Test St', 150000);
    markListingAsSeen(hash, uniqueId, `https://test.com/${uniqueId}`, '123 Test St', 150000);

    // Should still only be seen once
    expect(hasSeenListing(hash)).toBe(true);
  });
});
