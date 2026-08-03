# PanelFlow iOS

A native Swift shell around the same JavaScript PanelFlow runs everywhere else.
Tap the icon and you are in your library; search the web from inside the app;
open a scan site and read it in the PanelFlow reader.

**Building requires a Mac.** This monorepo was scaffolded on Windows, so the
Xcode project is generated rather than committed — everything needed to produce
it is here.

## Build

```sh
brew install xcodegen        # once
cd ios
xcodegen generate            # writes PanelFlow.xcodeproj
open PanelFlow.xcodeproj
```

`Scripts/bundle-assets.sh` runs as a pre-build phase and collects the web layer
into `ios/Generated/` (git-ignored). Run it by hand if you want to inspect what
gets bundled.

Point the app at a different backend by editing `PanelFlowBackendURL` in
`project.yml` — or from the account tab at runtime, which wins over the build
value.

## How it is put together

The app is not a reimplementation of the extension. It runs the extension's
code.

- **`ShellViewController`** hosts `mobile/www/index.html` — the library grid,
  folders, the search tab, the account panel. One implementation of the UI, used
  by the phone and (soon) the web app.
- **`WorkerHost`** owns an offscreen `WKWebView` running
  `shared/panelflow-core.js` with `localStorage` as its store. This is the iOS
  twin of the extension's MV3 service worker: library, progress, duplicate
  detection, migration and chapter checking are one body of code that every
  platform executes unchanged. Reimplementing it in Swift would mean a merge
  behaves one way on the phone and another in the browser.
- **`BrowserViewController`** is the in-app browser. `PageScripts` injects
  `popup-guard.js`, `detect.js`, `library-modal.js`, `reader.js` and
  `reader.css` **verbatim** from `extension/content/`; `chrome-shim.js` supplies
  the five `chrome.*` APIs they use and is the entire mobile-specific layer. Its
  bottom bar stands in for the extension popup and reaches the same content
  script handlers.
- **`Bridge`** is the single `WKScriptMessageHandler`, taking one JSON string.
  That is deliberately the whole attack surface: the same handler is attached to
  web views showing scan sites the app does not control.
- **`NativeMessages`** answers only what a web view cannot do for itself —
  `openUrl`, `share`, `nativeInfo` — and validates each on its own terms.
- **`ContentBlocker`** compiles `Resources/blocker-rules.json` into a
  `WKContentRuleList`. This is the deciding reason the app is native around
  `WKWebView` rather than React Native: no JS-level blocker matches a compiled
  rule list on a scan site.
- **`Notifications` / `ChapterCheck`** — the tray and `BGTaskScheduler`. The
  core decides *whether* a chapter is worth announcing and remembers that it
  did; native only renders it and hands back the tap.

Android's `WorkerHost`, `NativeBridge`, `NativeMessages` and `PageScripts` are
the same objects with the same names, doing the same jobs. That is intentional:
a change to the protocol should be obviously the same change on both sides.

## Not done yet

1. Offline downloads (URLSession background downloads, per-chapter folders)
2. APNs, so a chapter can arrive without the app having been opened
3. Sign in with Apple, StoreKit 2 for premium sync
