import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  TWILIO_ACCOUNT_SID: z.string().min(1, 'TWILIO_ACCOUNT_SID is required').optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1, 'TWILIO_AUTH_TOKEN is required').optional(),
  TWILIO_FROM: z.string().min(1, 'TWILIO_FROM is required').optional(),
  ALERT_RECIPIENTS: z.string().min(1, 'ALERT_RECIPIENTS is required').optional(),
  POLL_MINUTES: z.string().default('2'),
  NOMINATIM_EMAIL: z.string().email('NOMINATIM_EMAIL must be a valid email').optional(),
  RADIUS_MI: z.string().default('25'),
  ZIP: z.string().default('61611'),
  MIN_PRICE: z.string().default('70000'),
  MAX_PRICE: z.string().default('230000'),
});

const parseEnv = () => {
  const result = configSchema.safeParse(process.env);
  
  if (!result.success) {
    // In test environment, use defaults
    if (process.env.NODE_ENV === 'test') {
      return {
        TWILIO_ACCOUNT_SID: 'test',
        TWILIO_AUTH_TOKEN: 'test',
        TWILIO_FROM: '+15555551234',
        ALERT_RECIPIENTS: '+15555551234',
        POLL_MINUTES: '2',
        NOMINATIM_EMAIL: 'test@example.com',
        RADIUS_MI: '25',
        ZIP: '61611',
        MIN_PRICE: '70000',
        MAX_PRICE: '230000',
      };
    }
    
    console.error('❌ Configuration validation failed:');
    result.error.issues.forEach(err => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }
  
  return result.data;
};

const env = parseEnv();

export const config = {
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || 'test',
    authToken: env.TWILIO_AUTH_TOKEN || 'test',
    from: env.TWILIO_FROM || '+15555551234',
  },
  alertRecipients: (env.ALERT_RECIPIENTS || '+15555551234').split(',').map(r => r.trim()),
  pollMinutes: parseInt(env.POLL_MINUTES, 10),
  nominatimEmail: env.NOMINATIM_EMAIL || 'test@example.com',
  radiusMiles: parseFloat(env.RADIUS_MI),
  zip: env.ZIP,
  minPrice: parseInt(env.MIN_PRICE, 10),
  maxPrice: parseInt(env.MAX_PRICE, 10),
};
