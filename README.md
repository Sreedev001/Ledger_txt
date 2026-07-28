# Ledger — Android build

`src/LedgerApp.jsx` is included **unchanged** — nothing in the app's logic
was touched. Everything else here is packaging: a Vite build setup,
Tailwind, Capacitor (wraps the built web app in a real Android WebView), and
a GitHub Actions workflow that builds the APK for you.

## Option A — build via GitHub Actions (no local Android SDK needed)

1. Push this whole folder to a new GitHub repo:

   ```bash
   cd ledger-app
   git init
   git add .
   git commit -m "Ledger app"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

2. On GitHub, open the **Actions** tab of the repo. The "Build Android APK"
   workflow runs automatically on push (or trigger it manually from there
   via *Run workflow*).
3. When it finishes (a few minutes), open the completed run and scroll to
   **Artifacts** — download `ledger-debug-apk`, unzip it, and you have
   `app-debug.apk`.
4. Copy that APK to your phone (or `adb install app-debug.apk`) and install
   it — you may need to allow "install unknown apps" for whatever app you
   use to open it.

This works because GitHub's hosted runners come with the Android SDK
preinstalled, so `.github/workflows/android-build.yml` can run the full
`npx cap add android` → `gradlew assembleDebug` pipeline without you needing
Android Studio or the SDK on your own machine at all.

## Option B — build locally on Ubuntu instead

Only needed if you'd rather not use GitHub Actions.

Prerequisites: Node.js 18+, a JDK (`sudo apt install openjdk-17-jdk`), and
Android Studio (bundles the SDK): https://developer.android.com/studio

```bash
cd ledger-app
npm install
npm run build
npx cap add android
npx cap sync android
npx cap open android     # opens Android Studio — Run, or Build → Build APK(s)
```

Command-line only, without Android Studio's GUI (needs `ANDROID_HOME` set):

```bash
cd android
./gradlew assembleDebug
```

APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

## If you change the app later

Edit `src/LedgerApp.jsx`, commit, and push — the Action rebuilds
automatically. For a local build, repeat `npm run build && npx cap sync android`
before rebuilding.

## One thing to decide before your first install

`capacitor.config.json` sets `appId: "com.sreedev.ledger"` — Android treats
this as the app's permanent identity. Fine to leave as-is, but change it
**before** your first install if you want something different — changing it
afterward makes Android treat it as a different app, so old on-device data
doesn't carry over.

## What this does and doesn't change

- The WebView Capacitor uses is a real Android WebView — the same kind your
  custom Dialog/BottomSheet components were already written for (avoiding
  `window.prompt`/`confirm`/`alert`, handling the hardware back button via
  `popstate`).
- `localStorage` works normally inside the WebView, so accounts persist
  on-device exactly as before.
- Nothing about parsing, undo/redo, or any ledger behavior was changed —
  this is purely the native wrapper + build pipeline.

## Not included (only if you want it later)

- **Release signing** — this workflow builds a debug APK, fine for
  installing on your own device. A signed release build (for wider
  distribution) needs a keystore and a couple more workflow steps — say the
  word if you want that added.
- **Custom app icon/splash screen** — currently uses Capacitor's defaults.
