# Deploy the Threadbot backend

The backend is built and verified working. It needs a host to run on. Everything below
is ready — pick one option.

## Env vars the host must set
```
PRINTFUL_API_KEY=...
PRINTFUL_STORE_ID=15660989
OPENAI_API_KEY=...
SUPABASE_URL=https://dwexqosfijipthndmtvf.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_BUCKET=previews
GENERATE_VARIATIONS=2
# optional (Stripe order webhook): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
```

## Option A — Fly.io (I can do this with just a token)
1. You: create a Fly.io account → make an API token (`fly tokens create org`), paste it to me.
2. Me: `flyctl deploy` from this repo (Fly builds the Docker image remotely), set the
   secrets above, return the public URL.

## Option B — Render (one-time GitHub connect)
1. You: Render → New → Blueprint → connect `armordude10/claude-tb-rebuild` (it reads `render.yaml`).
2. Set the secret env vars in the dashboard. Render builds the Dockerfile and gives a URL.

## Option C — Any VM you have (Docker)
```
docker build -t threadbot-backend .
docker run -d -p 3000:3000 --env-file backend.env threadbot-backend
```
Put it behind HTTPS (Caddy/Cloudflare) and use that URL.

## After it's deployed
Set `window.THREADBOT_CONFIG.backendUrl = "https://<your-backend>/generate"` in
`mobile/www/threadbot-config.js`, then rebuild the APK (`npx cap sync android` +
`./gradlew assembleDebug`). The phone then does real AI generation.
