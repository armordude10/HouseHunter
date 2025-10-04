import Database from 'better-sqlite3';
import * as path from 'path';
import * as crypto from 'crypto';

const dbPath = path.join(__dirname, '..', 'seen_listings.db');
const db = new Database(dbPath);

// Initialize the database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_listings (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    url TEXT,
    address TEXT,
    price INTEGER,
    seen_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_hash ON seen_listings(hash)
`);

/**
 * Generate a hash for a listing to detect duplicates
 */
export function generateListingHash(source: string, id: string, url: string): string {
  const canonical = url.toLowerCase().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return crypto
    .createHash('sha256')
    .update(`${source}:${id}:${canonical}`)
    .digest('hex');
}

/**
 * Check if a listing has been seen before
 */
export function hasSeenListing(hash: string): boolean {
  const stmt = db.prepare('SELECT 1 FROM seen_listings WHERE hash = ?');
  const result = stmt.get(hash);
  return result !== undefined;
}

/**
 * Mark a listing as seen
 */
export function markListingAsSeen(
  hash: string,
  id: string,
  url: string,
  address: string,
  price: number
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO seen_listings (id, hash, url, address, price, seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, hash, url, address, price, Date.now());
}

/**
 * Get count of seen listings
 */
export function getSeenCount(): number {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM seen_listings');
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Close the database connection (for graceful shutdown)
 */
export function closeDatabase(): void {
  db.close();
}
