# native/ — the React Native client

The third shell, and the first one that can be built without a Mac.

`ios/` and `android/` hold a Swift and a Kotlin app around a WebView. This holds
an Expo app around the same WebView, and it exists for a practical reason rather
than an architectural one: **it can be run on a real phone today, from Windows,
with no toolchain to install** — Expo Go loads it over the network — and it can
be built for TestFlight on Expo's macOS machines rather than on a Mac in the
room. See [`../docs/tester-sur-iphone.md`](../docs/tester-sur-iphone.md).

## What is the same, and what is not

Everything the user reads and every decision about their library is still the
shared code, unforked:

| Layer | Where it runs here |
|---|---|
| `shared/panelflow-core.js` — library, progress, dedupe, sync | **in the app itself**, `src/core.js` |
| `extension/content/*.js` — detection, reader, library modal | injected into the browser WebView, `src/screens/BrowserScreen.js` |
| `mobile/inject/chrome-shim.js` — the five `chrome.*` APIs | injected first, unchanged |
| `mobile/inject/i18n.js` — `t()` for the injected scripts | injected before them, all three shells |
| `shared/_locales/` — every sentence | `generated/messages.js`, read by `src/i18n.js` |
| `shared/theme.css` — the palette | transcribed into `src/theme.js`, checked by a test |

The one real difference is the first row. Kotlin and Swift cannot run the core,
so both host it in an offscreen WebView and reach it over a bridge; React Native
*is* a JavaScript engine, so the core is imported and the bridge disappears.
`send({ type: 'getLibrary' })` in `src/core.js` is the same call
`chrome.runtime.sendMessage` makes in the extension, minus the round trip.

What that costs: the store is AsyncStorage rather than a WebView's
`localStorage`, so this client's library is its own until it is signed in — the
account is what makes them one library, here as everywhere else.

The screens are React Native views rather than the HTML in `mobile/www/`. That
tree is not used by this client and is not going away: it is what the Kotlin and
Swift shells render.

## Running it

```bash
cd native
npm install
npx expo start        # then scan the QR code with Expo Go
```

Every native module this app uses is one Expo Go already carries
(`react-native-webview`, AsyncStorage, notifications, crypto), so there is
nothing to compile to try it on a phone.

## Generated files

`generated/` is written by `npm run sync:shared` at the repo root and is
committed — a cloud build has no repository to regenerate it from:

- `generated/shared/*.js` — copies of `shared/`, same as every other client
- `generated/messages.js` — the locale catalogue as a script
- `generated/injected.js` — `extension/content/*` concatenated into two strings,
  the early set and the late set, because a Metro bundle has no `assets/`
  directory to read files out of at runtime
  (`scripts/build-native-inject.mjs`)

Do not edit them. `backend/test/native-shell.test.js` fails if they are stale,
and if the injection order here stops matching Kotlin's and Swift's.

## Not ported yet

Deliberately, so the reading path could be tested first. None of it is blocked —
each is a screen or a module, and the messages they need already exist in the
hub:

- **statistics and history** (`getStats`, `getHistory`) — the tab exists in the
  web shell and has no counterpart here yet
- **trackers** — AniList/MAL connection, matching, backfill
- **saved chapters** — `shared/offline-store.js` wants an IndexedDB; on this
  client it would want a filesystem, and that is a different implementation
  rather than a port
- **background chapter checks** — `checkNow` works from the account screen and
  the server keeps watching on its own cron; what is missing is the phone
  waking itself up (`expo-background-task`), which Expo Go cannot do anyway

## Three things worth knowing before you debug them

**Ad blocking is weaker here than anywhere else.** Chrome, Safari and Android
all refuse a request before it is made, from `shared/adblock-list.json` compiled
outside the page. React Native's WebView exposes no subresource hook at all —
`onShouldStartLoadWithRequest` only sees main-frame navigations — so
`native/inject/rn-adblock.js` enforces the same list from *inside* the page:
fetch, XMLHttpRequest, and elements as they are inserted. That covers what makes
a scan site slow, and it cannot cover what it cannot see.

**Search is a server route, and the server is currently refused.** `/api/search`
scrapes DuckDuckGo's no-JS page, which answers a datacenter IP with a challenge
— so the deployed backend gets nothing and every client, this one included, is
told `search unavailable`. Nothing on the phone can fix that. What the phone can
do is what it now offers when the call fails: run the same words as a plain web
search in its own browser, which is a browser and is allowed to ask.

**The settings are projected by hand.** `src/prefs.js` is a second copy of the
logic in `extension/background.js`'s `getPrefs`/`setPrefs` — which of the three
stores each setting belongs in. It should be shared code and is not yet; if you
change one, read the other.
