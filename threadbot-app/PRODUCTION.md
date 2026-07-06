# Threadbot — Production & Publishing Readiness

This is the honest, complete checklist to take Threadbot from "working test build"
to "published app." Items marked **DONE** are implemented. Items marked **YOU**
require an account/credential only you can create (I'll do all the wiring).

---

## 1. Backend & data — **DONE** (Supabase)

Supabase is the production backend (same role Firebase would play). Switching to
Firebase would mean rebuilding the catalog vector-search, image storage, auth, and
sync that already work — no functional gain, so we stay on Supabase.

- Auth (JWT), Postgres, Row-Level Security, Storage, vector catalog — all live.
- Generation backend deployed (Hugging Face), keys stored as secrets.
- Per-account sync of closet/designs/profile via `app_state` (RLS-isolated).

## 2. Authentication

- **DONE — Email + password** with **email verification** (confirm link + resend).
- **DONE — Session persistence / auto-refresh**, per-account data isolation (RLS).
- **DONE (code) — Google + Microsoft buttons** are in the app with the full native
  flow (system browser → `threadbot://auth-callback` deep-link →
  exchange code for session). They light up the moment you enable each provider —
  **no reinstall needed.** Do this once:

  **Google (free, ~10 min)**
  1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → **Web application**.
  2. Authorized redirect URI: `https://dwexqosfijipthndmtvf.supabase.co/auth/v1/callback`
  3. Copy the **Client ID** + **Client Secret**.
  4. Supabase → Authentication → Providers → **Google** → enable → paste both → save.

  **Microsoft / Azure (free, ~10 min)**
  1. Azure Portal → App registrations → New registration (Accounts: "any org + personal").
  2. Add a **Web** redirect URI: `https://dwexqosfijipthndmtvf.supabase.co/auth/v1/callback`
  3. Copy **Application (client) ID**; Certificates & secrets → new client secret → copy **Value**.
  4. Supabase → Authentication → Providers → **Azure** → enable → paste ID + secret → save.

  **Both** — Supabase → Authentication → **URL Configuration → Redirect URLs** → add
  `threadbot://auth-callback`.

  Ping me when they're enabled and I'll verify the deep-link round-trip on your device.

- **Apple Sign-In (later, $99/yr).** Note: once you publish to the **App Store** while
  offering Google/Microsoft login, Apple's guideline 4.8 effectively requires Apple
  Sign-In too — so budget the $99/yr Apple Developer account for the iOS release.

- **Optional — turn off email confirmation** for frictionless signup during testing:
  Supabase → Authentication → Providers → Email → toggle "Confirm email" off.

## 3. Mobile app shell — **DONE**

- Full-screen edge-to-edge layout (no device frame), safe-area insets, real tabs.
- App icon (adaptive launcher, all densities) + splash from your robot logo.
- Capacitor Android project, debug build installable today.

## 4. Publishing — **YOU** (accounts) **+ me** (build/config)

### Google Play
- **YOU:** Play Console account — **$25 one-time**.
- **me:** release **signed AAB**, app icons (done), store listing copy, content
  rating questionnaire answers, data-safety form.
- **YOU + me:** a hosted **privacy policy URL** (required). I can generate the
  policy text; you host it (free on your domain or GitHub Pages).

### Apple App Store
- **YOU:** Apple Developer Program — **$99/yr**, and a **Mac with Xcode** to build/submit.
- **me:** add the iOS Capacitor platform, configure signing, icons, launch screen.
- Note: iOS is a separate platform we haven't built yet; it's added on request.

### Required for either store
- [ ] Privacy policy (collects email + designs) — **I'll draft, you host**
- [ ] Terms of Service — I'll draft
- [ ] Account deletion path (Apple/Google require it) — I'll add an in-app "Delete account"
- [ ] App version/build numbers, store screenshots (from the device)

## 5. Security hardening — partially **DONE**

- **DONE:** RLS on user data; backend behind JWT; supplier hidden; secrets server-side.
- **YOU (now):** rotate the keys shared in chat (OpenAI, Printful, Supabase service
  role, HF token), then update the HF Space secret. Nothing else references them.
- **Recommended:** rate-limit `/generate` per user (prevents OpenAI cost abuse) — I'll add.

---

## Cost reality (you said budget is tight)
- **Free path to a real, installable app:** everything above except store publishing.
  Sideload the APK / distribute the link — fully functional, $0.
- **Google Play:** $25 one-time.
- **Apple App Store:** $99/yr + a Mac.
- Social logins: Google + Microsoft are **free** to set up; **Apple costs $99/yr**.

So you can have a fully working app with Google + Microsoft + email login for **$0**,
and add Apple / store publishing when budget allows.
