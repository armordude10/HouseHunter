# Threadbot — Release Guide (Google Play + Apple App Store)

This covers what's already done, what only you can do, and the exact steps for each store.

---

## ✅ What's already set up (Android)
- **App ID:** `org.artincpeoria.threadbot` · **Version:** 1.0 (versionCode 1)
- **Release signing** configured (`app/build.gradle` + `keystore.properties`)
- **Minimal permissions** — only `INTERNET` (clean Data Safety form)
- **Adaptive launcher icons** present at all densities
- **Signed release `.aab`** (App Bundle — what Play wants) + a signed release `.apk` for sideload testing

## 🔐 CRITICAL — protect your signing key
The upload key is at `mobile/android/app/threadbot-upload.keystore`, and its password is in
`mobile/android/keystore.properties` (both are **gitignored — they are NOT in your repo**).

**Back both up somewhere safe (password manager + offline copy) right now.**
If you lose this keystore/password you can no longer push updates under the same upload key
without a Google key-reset request. Treat it like the master key to your app.

---

## 🤖 Google Play — steps (you do these)
1. **Create a Play Console account** (one-time $25): https://play.google.com/console
2. **Create app** → name "Threadbot", app (not game), free/paid.
3. **Upload the AAB:** Production → Create release → upload `app-release.aab`.
   - Accept **Play App Signing** (recommended) — Google manages the app signing key; your
     keystore stays the *upload* key.
4. **Store listing:** short + full description, app icon (512×512), feature graphic (1024×500),
   and **phone screenshots** (at least 2). 
5. **Data safety form:** collected data = email, name, shipping address, photos (reference images),
   user content. Shared with payment/fulfillment processors. (Matches `PRIVACY.md`.)
6. **Privacy policy URL:** host `PRIVACY.md` publicly and paste the link.
7. **Content rating** questionnaire + **target audience** (18+ recommended).
8. Roll out to **production** (or start with internal/closed testing).

## 🍎 Apple App Store — Cloud/CI build (no Mac needed by you)
> iOS can only be compiled on macOS, so we build it on a **GitHub-hosted macOS runner**. It
> generates the iOS project from the same `www/`, registers the `org.artincpeoria.threadbot` URL
> scheme (OAuth + checkout return), and builds.

**Setup (one-time):** the workflow file is provided at **`mobile/ci/ios-build.yml`**. Add it to
your repo at **`.github/workflows/ios-build.yml`** (easiest: GitHub web UI → Add file → paste the
contents — the automation token couldn't push workflow files for you, but you as the owner can).

**Step 1 — verify it compiles (no Apple account needed):**
GitHub → Actions → "iOS build (App Store)" → Run workflow (leave `signed` = false). This does an
unsigned compile to confirm the app builds on iOS.

**Step 2 — signed TestFlight/App Store build:** you need an **Apple Developer account** ($99/yr).
1. Register the bundle id `org.artincpeoria.threadbot` and create the app in **App Store Connect**.
2. Create an **App Store Connect API key** (Users and Access → Integrations → App Store Connect API),
   download the `.p8`.
3. Add these **GitHub repo secrets** (Settings → Secrets → Actions):
   - `APP_STORE_CONNECT_KEY_ID` — the key's ID
   - `APP_STORE_CONNECT_ISSUER_ID` — the issuer ID
   - `APP_STORE_CONNECT_API_KEY_B64` — the `.p8` contents, base64-encoded (`base64 -i AuthKey.p8`)
4. Run the workflow with `signed = true`. It archives, exports, and the IPA is uploaded to App
   Store Connect (and saved as a build artifact).
5. In **App Store Connect:** fill listing + screenshots, attach the **privacy policy URL**,
   complete **App Privacy** answers, submit for review.

> Alternatively, on a local Mac: `cd mobile && npm install && npx cap add ios && npx cap open ios`,
> set your Team + signing in Xcode, then Product → Archive → Distribute.

---

## ⚠️ One open item: target API level
Google Play requires **new apps to target API 35 (Android 15)**. This build targets API 34.
Bumping to 35 requires upgrading the Android Gradle Plugin (8.2 → 8.6+) and a quick re-test of the
full-screen layout (Android 15 enforces edge-to-edge). The app already uses safe-area insets, so
it should be fine — but because it's the one change that could shift the UI, do it as a verified
step. Say the word and I'll bump + rebuild so the AAB is Play-acceptable.

## Rebuilding later
```bash
cd mobile/android
ANDROID_HOME=<sdk> JAVA_HOME=<jdk> ./gradlew :app:bundleRelease   # -> app/build/outputs/bundle/release/app-release.aab
```
Bump `versionCode` (and `versionName`) in `app/build.gradle` for every new upload.
