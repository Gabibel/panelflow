# PanelFlow architecture notes

## Detection & extraction resilience

Source sites change DOM structure constantly. Four-layer defense:

1. **Generic heuristics** (no per-site knowledge): image-gallery clustering, URL
   patterns, chapter-nav text, text density. Works zero-shot on unseen sites.
2. **Reader engines** (`engines` in `shared/detection-rules.json`): most scan
   sites are not bespoke, they are one of a handful of WordPress/CMS themes —
   Madara, Themesia, MangaNato, FoolSlide. Each engine is recognised by its own
   markup (a `detect` selector list for a live DOM, a `signature` substring list
   for raw HTML on the server), never by hostname, so one entry covers hundreds
   of sites nobody has to list. Engines carry the same selectors a domain entry
   does, and are worth `knownEngine: 40` — deliberately *below* the score
   threshold, because a theme's own home page is built from that theme too.
3. **Per-domain rules** (`domains` in the same file, served by `/api/rules`):
   CSS selectors for the image container, next/prev chapter, title, reading
   direction. Matched exact host → bare host → wildcard suffix (`*.example.com`,
   never a bare `*.com`), and merged *over* whatever engine the page uses, so a
   domain entry only has to say what its site does differently. Worth
   `knownDomain: 100`: someone looked at this site.
4. **Graceful fallback**: if extraction fails, the page stays a normal browser
   tab. Reader Mode is opt-in per activation, so breakage is never destructive.

`shared/site-rules.js` is the single answer to "which site is this?" — a pure
function over rules plus either a DOM or a string, so the content script, the
mobile worker and the server all resolve a page the same way. Its selectors are
strictly additive: `imageContainer` narrows the gallery scan and falls back to
the whole document if the named container comes up short, so a stale selector
can lose precision but never detection.

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

## One shelf, one order

The popup and the web app draw the same library, and a sort order that disagrees
between them is a bug even though both "work". `shared/library-view.js` is the
only copy of that rule — `sortLibrary`, `filterLibrary`, `tagCounts` — generated
into `extension/shared/` and `web/shared/` by the same sync script. It is pure:
rows in, rows out, no storage and no DOM, so it is testable on its own
(`backend/test/library-view.test.js`, which also asserts both clients still call
it rather than sorting inline again).

Progress is reached through a `progressOf(entry)` callback because the clients
key it differently — the extension by source URL, the web app by library id —
and `folderOf` exists for the same reason: the web app folds a folder it does
not recognise into "reading" so no row can fall through every tab.

The chosen order and filters are stored per device (`localStorage` on the web,
`chrome.storage.local` in the extension), not on the account: which way you like
to look at a shelf belongs to the screen you are sitting at.

## What a folder is

`library.folder` holds exactly one value per entry, and it is one of two kinds.

**A built-in folder** — `reading`, `paused`, `plan`, `completed`, `dropped`.
Five, fixed, the same in every client, named in exactly one file:
`shared/folders.js`. The backend reaches it through the ESM face
`backend/src/folders.js`; the three clients load it as a plain script and read
`globalThis.PanelFlowFolders`. `backend/test/mobile-shell.test.js` fails if any
of them grows a second copy of the list.

**A shelf of the user's own** — `cat:<id>`, a row in `categories`. A shelf is
*not* a sixth status: it **stands for** one of the five, which is what its
`status` column holds. Everything that has to decide something about a series
asks `folderStatus(folder, categories)` and never the folder itself — whether
the watcher checks it (`backend/src/routes/watch.js` does it in SQL, with a
correlated `SELECT 'cat:' || id FROM categories WHERE status IN (…)`), what it
exports to MyAnimeList as, which bar of the stats it lands in. Without that
rule, filing a series more carefully is how you make it silently stop being
watched.

Tags are the other axis and stay the other axis: a series has any number of
tags and lives in exactly one folder. That is why a category is a value of the
`folder` column and not a second column — two columns admit a state where an
entry is in a built-in folder *and* a shelf, and then every tab row has to
decide which lie to tell.

A backup carries its `categories`, and `restoreBackup` matches them **by name**
(NOCASE) rather than by id: restoring into an account that already has a
"Weekly" reuses it instead of leaving two tabs nobody can tell apart. Ids are
always regenerated and every entry's folder is remapped. The backup version is
deliberately not bumped — an older reader ignores the key and folds unknown
`cat:` folders into reading, which is a better outcome than refusing the file.

Deleting a shelf is a `db.batch` that re-files its entries onto its status
*first* and drops the row second, so there is never a moment where a library row
points at a category that does not exist.

## New-chapter checking

Two halves, because neither one covers the other's gap.

Client-side (`chrome.alarms`, 6h default, 2s between requests,
`credentials: 'omit'`) reaches sites the server cannot: a Cloudflare-walled
scan site answers a browser and challenges a datacentre.

Server-side (`backend/src/routes/watch.js`, a Vercel cron hitting
`/api/watch/run`) covers the hours the browser is not running at all. One fetch
per series serves every account following it, hosts are paced and run in
parallel with each other but never with themselves, and a run is bounded by a
wall-clock deadline rather than a row count — series are taken oldest
`checked_at` first, so consecutive runs rotate through the library instead of
one run trying to check all of it. What it finds lands in `news`, and the first
client to wake up drains it (`pullNews`) into the notification nobody was there
to see. Still missing: conditional requests (ETag/Last-Modified).

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
