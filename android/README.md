# PanelFlow Android

A native Kotlin shell around the same JavaScript PanelFlow runs everywhere else.
Tap the icon and you are in your library; search the web from inside the app;
open a scan site and read it in the PanelFlow reader.

## Build

```sh
cd android
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`. Gradle's `bundleWebAssets` task
syncs the web layer out of `mobile/`, `shared/` and `extension/content/` into the
assets folder on every build — nothing is committed twice.

Point a build at a different backend:

```sh
./gradlew assembleDebug -Ppanelflow.backendUrl=http://10.0.2.2:3000
```

The account tab overrides it at runtime.

## How it is put together

The app is not a reimplementation of the extension. It runs the extension's
code.

- **`MainActivity`** hosts `mobile/www/index.html` — the library grid, folders,
  the search tab, the account panel. Served over
  `https://appassets.androidplatform.net` through `WebViewAssetLoader`, not
  `file://`, so the shell has a real origin and therefore durable
  `localStorage`.
- **`WorkerHost`** owns an offscreen `WebView` running
  `shared/panelflow-core.js` with `localStorage` as its store — the twin of the
  extension's MV3 service worker. Library, progress, duplicate detection,
  migration and chapter checking are one body of code that every platform
  executes unchanged.
- **`BrowserActivity`** is the in-app browser, and also what handles a shared
  link or an `http(s)` `VIEW` intent. `PageScripts` injects `popup-guard.js`,
  `detect.js`, `library-modal.js`, `reader.js` and `reader.css` **verbatim**
  from `extension/content/`; `chrome-shim.js` supplies the five `chrome.*` APIs
  they use and is the entire mobile-specific layer. Its bottom bar stands in for
  the extension popup.
- **`NativeBridge`** is a single `@JavascriptInterface` method taking one JSON
  string. That is deliberately the whole attack surface: the same interface is
  attached to web views showing scan sites the app does not control.
- **`MangaWebViewClient` + `AdBlockList`** block per request, reading the host
  list out of the extension's own `rules/adblock.json` and honouring the same
  `whitelist` setting the extension's options page writes.
- **`Notifications` / `ChapterCheckWorker`** — the tray and a six-hour
  WorkManager job. The core decides *whether* a chapter is worth announcing and
  remembers that it did; native only renders it and hands back the tap.

iOS's `WorkerHost`, `Bridge`, `NativeMessages` and `PageScripts` are the same
objects with the same names, doing the same jobs. That is intentional: a change
to the protocol should be obviously the same change on both sides.

## Not done yet

1. Offline downloads (WorkManager + OkHttp, per-chapter dirs)
2. FCM, so a chapter can arrive without the app having been opened
3. Google Sign-In, Play Billing for premium sync
