# Deploy the pipeline (free options first)

Stands up the Threadbot Runware pipeline as a **new, standalone** public service.
It does not touch your local pipeline or your normal deployment process.

> Only the LLM + artwork nodes run fully on Runware. The 8 tool-using nodes still
> need the four Threadbot MCP backends reachable (see "MCP backends" at the end).

## Option A — Render (free, no credit card) ★ recommended

Render free web services are $0, give a public HTTPS URL, and deploy from GitHub.
They sleep after ~15 min idle and cold-start in ~1 min (fine for a demo).

1. Your branch is already on GitHub.
2. Go to **render.com → New → Blueprint** and select this repo/branch. Render
   reads `render.yaml` and configures the service automatically.
3. When prompted, paste your **RUNWARE_API_KEY** (stored as a secret, never in git).
4. Render builds the `Dockerfile` and gives you a URL like
   `https://threadbot-runware-demo.onrender.com`.

Smoke-test it:

```bash
URL=https://threadbot-runware-demo.onrender.com
curl -s $URL/health
curl -s -X POST $URL/run -H 'Content-Type: application/json' \
  -d '{"input_as_text":"black streetwear tee with a neon koi fish, no logos"}'
```

## Other free/cheap hosts (same Dockerfile)

- **Hugging Face Spaces** (free, Docker SDK): new Space → Docker → point at this
  repo; add `RUNWARE_API_KEY` as a Space secret. The container listens on `$PORT`.
- **Koyeb** free tier: one always-on service from a Dockerfile, public URL.
- **Fly.io**: `fly launch` from this repo (uses the Dockerfile); scale-to-zero
  keeps it near-free. Requires a card on file.

All of these use the existing `Dockerfile` and the `RUNWARE_API_KEY` env var; the
server binds `0.0.0.0` on `$PORT`, so nothing else needs changing.

## Option B — Cloud Run (only if you already use GCP)

## 1. Deploy (run locally, where `gcloud` is authed)

From the repo root:

```bash
gcloud run deploy threadbot-runware-demo \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 600 \
  --set-env-vars RUNWARE_API_KEY=YOUR_RUNWARE_KEY
```

Notes:
- `--region us-central1` matches your existing MCP servers (`...-uc.a.run.app`).
- `--allow-unauthenticated` is what lets the phone/app reach it. Fine for a
  short demo; delete the service afterward (below).
- `--timeout 600` — the pipeline makes ~13 model calls plus image generation, so
  give it headroom.
- If the MCP servers need a token, also add
  `--set-env-vars ...,THREADBOT_MCP_BEARER=YOUR_TOKEN` (comma-separated, one
  `--set-env-vars`).

`gcloud` prints a service URL like
`https://threadbot-runware-demo-xxxxx-uc.a.run.app`. That is your temporary
pipeline endpoint.

## 2. Smoke-test the URL before the meeting

```bash
URL=https://threadbot-runware-demo-xxxxx-uc.a.run.app

curl -s $URL/health

curl -s -X POST $URL/run \
  -H 'Content-Type: application/json' \
  -d '{"input_as_text":"black streetwear tee with a neon koi fish, no brand logos"}'
```

`/run` returns:

```json
{ "ok": true, "status": "success", "result": { ...FinalResponseComposer output... }, "elapsed_ms": 12345 }
```

If `ok:false`, the `error` field tells you what broke (bad key, MCP auth, or a
model/tool-call mismatch). This is the moment to catch it — not in the meeting.

## 3. Point the Threadbot app at it

The app currently calls whatever your **local** pipeline exposes. Replace that
target with the Cloud Run URL. To find the target:

1. Check the app for a **Settings / Developer / Server URL** field — paste the
   Cloud Run URL there if it exists.
2. Otherwise, look at what your local pipeline listens on and where the app is
   told to find it (app config, `.env`, pairing QR, etc.) — swap that value.
3. To learn the exact request/response the app expects, watch your local
   pipeline's logs (or proxy the phone with Charles/Proxyman) while you run one
   request. Send me that exact payload shape and I'll reshape `/run` to match it
   in a couple of minutes — right now `/run` accepts
   `input_as_text | prompt | message | text` and returns the final node JSON.

**Fallback if the app can't be repointed in time:** demo the pipeline directly —
POST to `$URL/run` from Postman or a phone browser tool on a shared screen. That
still shows the full pipeline running end to end on Runware.

## Tear down a Cloud Run demo (if you used Option B)

```bash
gcloud run services delete threadbot-runware-demo --region us-central1
```

## MCP backends (the remaining piece)

The pipeline's 8 tool-using nodes call four Threadbot MCP services
(`policy`, `product-intelligence`, `pricing-agentbuilder`, `printful-mockups`).
To run those on a free host instead of Cloud Run, their **source code** is needed
so they can be containerized and deployed the same way (Render Blueprint / HF
Space / Koyeb). Point this repo/session at wherever that code lives (a GitHub
repo works best) and each service can get its own free Render web service; then
set the four MCP URLs the pipeline uses via env/config. Until those four are
reachable, Intake, Customer Intent, Design Program, Placement Bundle (artwork),
and Final Response still run; the product/pricing/mockup nodes cannot.
