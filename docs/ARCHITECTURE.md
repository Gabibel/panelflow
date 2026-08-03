# PanelFlow architecture notes

## Detection & extraction resilience

Source sites change DOM structure constantly. Three-layer defense:

1. **Generic heuristics** (no per-site knowledge): image-gallery clustering, URL
   patterns, chapter-nav text, text density. Works zero-shot on unseen sites.
2. **Per-domain rules** (`shared/detection-rules.json`, served by `/api/rules`):
   CSS selectors for the image container, next/prev chapter, title, reading
   direction. Purely additive — when a selector breaks, heuristics still fire.
3. **Graceful fallback**: if extraction fails, the page stays a normal browser
   tab. Reader Mode is opt-in per activation, so breakage is never destructive.

Rules are remote config: clients cache with a TTL and version field; fixing a
broken site = editing one JSON on the server. No app-store release.

## Sync model

Local-first everywhere. The client stores library + progress locally and works
fully offline/signed-out (free tier). When a JWT is present, writes are mirrored
to the backend (last-write-wins per series via `updatedAt`). Premium gating
happens at the API level (`users.tier`), not in the client.

## One work, one entry

Two entries for the same book is the failure mode this design fights hardest,
because each one collects its own half-finished bookmark and neither is right.

`shared/series-match.js` holds the whole answer, and is the *only* copy of it:
`backend/src/series-match.js` re-exports it, `extension/shared/series-match.js`
is a generated duplicate (Chrome cannot load a content script from outside the
extension directory — `npm run sync:shared`, and the test `shared sources are in
sync` fails if it drifts).

Two layers, because they answer different questions:

- **Same site** — `seriesKey(url)` reduces a URL to `host|slug`, dropping
  section names (`/manga/`, `/lecture-en-ligne/`) and chapter counters
  (`/chapitre-109`, `-Chapitre-109-FR_330666`). Deterministic, so it merges
  silently: `dedupeLibrary` and `findEntry` both run on it.
- **Different site** — nothing in `https://a.test/ao-no-hako` and
  `https://b.test/blue-box` says they are one book, so the comparison falls back
  to titles: normalise away the scanlation furniture (`VF`, `Scan`,
  `Lecture en ligne`, `Chapitre 109`), then Sørensen–Dice over character
  bigrams, cross-multiplied with any alternative titles the page listed. This is
  a *guess*, so it never merges by itself — `classify` returns a confidence and
  the user is asked.

When the user accepts, `POST /api/library/:id/migrate` (and `migrateEntry` in
the service worker, for the signed-out case) moves the entry rather than adding
a second: progress, score, note, tags, folder and `dateAdded` come along, the
old site lands in `previous_sources`, and a bookmark left pointing into the
abandoned site is re-aimed at the new series page. If the destination is already
its own entry the two are merged — furthest chapter, union of tags, earlier
`dateAdded` — because `UNIQUE (user_id, source_url)` cannot hold both.

## New-chapter checking

v1 is client-side (`chrome.alarms`, 6h default) with 2s spacing between requests
and `credentials: 'omit'`. The planned server-side watcher must implement
per-domain rate limits, conditional requests (ETag/Last-Modified) and a shared
cache so N users watching the same series cost one fetch.

## Privacy stance

Differentiator: **privacy-first**. No third-party analytics/ads SDKs. The
backend stores only what sync requires (email, library, progress, tracker
tokens). Ship: in-app privacy policy, GDPR export (`GET /api/me/export` —
backlog) and account deletion cascade (FK `ON DELETE CASCADE` already in place).

## Store compliance (read before submission)

- The app is a **browser with a reading mode**, not a content aggregator: no
  hosted catalog, no featured sites, no content indexing. Position it exactly
  like Safari Reader / Firefox Reader View in review notes.
- Apple 2.5.6 (browsers must use WebKit) is satisfied by WKWebView.
- Both stores may probe on piracy facilitation: do not pre-load, suggest, or
  bundle links to any manga site. Detection is user-navigation-triggered only.
- Have a takedown/contact channel ready; respond to review questions with the
  "user-directed general-purpose browser" framing and the ad-block/reader-mode
  precedents.

## Native shells reuse the JS core

The phone apps share more than the reader: they share the store.

`shared/panelflow-core.js` is a single factory, `createCore({ storage, fetch,
notify, now, uuid, defaults })`, holding everything that decides what a library
*is* — adding, deduplicating, migrating a series between sites, advancing
progress, deciding a chapter is new. It is driven by `chrome.storage.local` in
the extension, by `localStorage` in the mobile worker WebView, and by a fake
store in the tests, and it does not know the difference. `createHub(core,
extras)` puts one `{ type, ... }` protocol in front of it, spoken by
`chrome.runtime.sendMessage`, by iOS's `WKScriptMessageHandler` and by Android's
`@JavascriptInterface` alike.

So each platform hosts a *worker*: the MV3 service worker in Chrome, an
offscreen `WebView`/`WKWebView` on the phones (`android/.../WorkerHost.kt`,
`ios/Sources/WorkerHost.swift`). Offscreen rather than native-owned because
`localStorage` belongs to an origin, and the store has to live on the same side
of the bridge as the code that mutates it — otherwise every merge becomes a
round trip, and the merge itself gets written three times and drifts twice.

The payoff is concrete. `rekeyProgress` — re-filing a bookmark when a series'
canonical URL moves, which used to silently orphan "Continue reading" — was one
fix in one file, and Chrome, Android and iOS all stopped losing the user's
place.

Injected page scripts follow the same rule. `extension/content/{detect,reader,
library-modal,popup-guard}.js` are dependency-free and guarded
(`window.__panelflow*Loaded`) so they can be injected repeatedly. The only
Chrome APIs they touch are `chrome.runtime.sendMessage` and
`chrome.storage.local`; mobile ships a small `chrome-shim.js` mapping those to
`webkit.messageHandlers` (iOS) / `@JavascriptInterface` (Android), and the files
themselves are bundled **verbatim** — Gradle's `bundleWebAssets` task and
`ios/Scripts/bundle-assets.sh` copy them out of `extension/content/` at build
time. There is no mobile fork of the reader.

Native's remaining share is only what a web view cannot do: notifications, the
background chapter check (`chrome.alarms` / WorkManager / `BGTaskScheduler`),
per-request ad blocking, and opening another app.
