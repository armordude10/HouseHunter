import * as cron from 'node-cron';
import { config } from './config';
import { run } from './runner';
import { closeDatabase } from './db';

console.log('🏠 HomeAlert61611 - Home Listing Alert System');
console.log('==============================================');
console.log(`📍 Target: ZIP ${config.zip} (${config.radiusMiles}mi radius)`);
console.log(`💰 Price range: $${config.minPrice.toLocaleString()} - $${config.maxPrice.toLocaleString()}`);
console.log(`📱 Recipients: ${config.alertRecipients.length}`);
console.log(`⏱  Poll interval: ${config.pollMinutes} minute(s)`);
console.log('==============================================\n');

// Run immediately on startup
console.log('Running initial check...');
run().catch(error => {
  console.error('Error in initial run:', error);
});

// Schedule the cron job
const cronExpression = `*/${config.pollMinutes} * * * *`;
console.log(`Scheduling cron job: ${cronExpression}`);

const task = cron.schedule(cronExpression, () => {
  run().catch(error => {
    console.error('Error in scheduled run:', error);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down gracefully...');
  task.stop();
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nShutting down gracefully...');
  task.stop();
  closeDatabase();
  process.exit(0);
});

console.log('✓ Application started. Press Ctrl+C to stop.\n');
