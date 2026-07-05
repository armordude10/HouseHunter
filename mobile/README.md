# Threadbot Mobile (Capacitor shell)

Wraps the pipeline service UI (https://threadbot-agentic-pipeline-2uts5km5aq-uc.a.run.app)
so the app always reflects the deployed backend: full-catalog product picker,
text + up to 10 reference images, express/premium modes, official Printful
mockup gallery, per-run cost readout.

## Android
Prebuilt debug APK: built from android/ with `gradle assembleDebug`
(ANDROID_HOME required). For Play Store: `gradle bundleRelease` + your
signing key (or Play App Signing).

## iOS
ios/ is a complete Capacitor Xcode project. Building an .ipa requires
Xcode on macOS (Apple's toolchain does not run on Linux):
  cd mobile && npm install && npx cap sync ios
  open ios/App/App.xcworkspace   # then Product > Archive
For the App Store you'll need an Apple Developer account + signing.

## Store notes
A pure remote-URL wrapper can trip Apple review (guideline 4.2); before
App Store submission, move the UI into www/ (already included as fallback)
and set webDir-only mode in capacitor.config.json.
