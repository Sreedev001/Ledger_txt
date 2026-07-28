# Ledger — Android app (Capacitor + React)

A plain-text expense ledger, wrapped as an installable Android app.

## What's fixed vs. the earlier version

1. **New account** — `window.prompt()` is blocked or unreliable inside most
   Android WebViews, which is why it silently did nothing before. It's been
   replaced with an in-app dialog (`Dialog` component in `LedgerApp.jsx`),
   used for new/rename/delete everywhere.
2. **Local storage** — all accounts and the active account name are written
   to `localStorage` on every change and reloaded on launch, so your data
   survives closing the app. (Backed by the WebView's local storage DB —
   persists across app restarts, cleared only if you clear app data.)
3. **Undo / redo** — now a real per-account history stack (coalesced into
   ~800ms bursts) instead of the old `document.execCommand`, which many
   WebViews don't support at all.
4. **Sheets (totals / accounts / menu)** — each one now has an explicit
   "Close" button (top-right and bottom), and the Android hardware back
   button closes the open sheet instead of exiting the app — it only exits
   when nothing is open.
5. **Three-dot menu** — save/open `.txt`, rename, delete, format guide all
   route through the same in-app dialogs, so they work identically on
   desktop, in a browser, and inside the Android WebView.

## Building the APK on GitHub (no local Android Studio needed)

1. Push this whole folder to a new GitHub repo.
2. GitHub Actions (`.github/workflows/android-build.yml`) runs automatically
   on every push to `main`, and can also be triggered manually from the
   **Actions** tab (`Run workflow`).
3. It builds the web app, adds the Android platform via Capacitor, and
   compiles a debug APK.
4. Open the finished workflow run → **Artifacts** → download
   `ledger-debug-apk`. Unzip it, you'll get `app-debug.apk`.
5. Copy that APK to your phone and install it (you'll need to allow
   "install unknown apps" for whichever app you use to open it).

This produces a **debug** build, fine for your own phone. For a real
Play Store release you'd later add a signing key and switch the workflow
to `assembleRelease` — not needed just to use it yourself.

## Local development (optional)

```bash
npm install
npm run dev        # live preview in a normal browser
```

## Rebuilding after code changes

Any time you edit `src/LedgerApp.jsx`, just commit and push — the GitHub
Action rebuilds the APK from scratch each time. There's no need to run
`cap add android` yourself; the workflow does it (or syncs it) automatically.

## App icon / name

Defaults to the Capacitor placeholder icon and the name "Ledger"
(`capacitor.config.json`). You can customize the icon later with
`@capacitor/assets` once you're happy with functionality.
