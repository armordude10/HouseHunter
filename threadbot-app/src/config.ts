import "dotenv/config";

export const config = {
  printful: {
    apiKey: process.env.PRINTFUL_API_KEY ?? "",
    storeId: process.env.PRINTFUL_STORE_ID ?? "",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    textModel: process.env.OPENAI_TEXT_MODEL ?? "gpt-5.5",
    imageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5",
    imageSize: process.env.OPENAI_IMAGE_SIZE ?? "1024x1536",
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  },
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    bucket: process.env.SUPABASE_BUCKET ?? "previews",
  },
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000/public",
  // Stripe checkout: unit price (cents) and the https base for hosted success/cancel pages.
  priceUsdCents: parseInt(process.env.PRICE_USD_CENTS ?? "2999", 10),
  checkoutBaseUrl: (process.env.CHECKOUT_BASE_URL ?? "https://threadbot-threadbot-backend.hf.space").replace(/\/+$/, ""),
  appScheme: process.env.APP_SCHEME ?? "threadbot",
  generateVariations: parseInt(process.env.GENERATE_VARIATIONS ?? "1", 10),
  port: parseInt(process.env.PORT ?? "3000", 10),
};
