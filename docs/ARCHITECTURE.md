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
to see.

The watcher re-reads the same few hundred pages every night, so it stores the
`ETag` and `Last-Modified` a page came with and quotes them back next time. A
`304` is then a header exchange instead of a megabyte of HTML, and it is taken
at its word: the body is not parsed and nothing is announced. Two details are
load-bearing. `checked_at` is written on a `304` and on a failure alike — it is
the rotation's cursor, not a record of success, and a series that stopped
moving must not be re-asked first forever. And the validators are only replaced
when a body actually arrived with them: a `304` carries none, and the curl
fallback for Cloudflare-walled sites carries none either, so overwriting with
null would throw away the very thing that produced the cheap answer.

### Reaching a browser that is closed

Draining `news` still requires a client to open. Web Push closes that last gap:
at the end of a watcher run, the rows it *actually inserted* are grouped per
account and pushed (`backend/src/routes/push.js`), so four series that all
updated overnight are one banner rather than four, and a chapter announced
yesterday is not announced again — the grouping is fed by `INSERT OR IGNORE`'s
`changes`, not by a second query.

Push is the fast path, never the only one. A push that fails is not lost news:
the `news` row is still there and the old drain still produces the notification,
which is why nothing here retries. A `404` or `410` from the push service is the
one answer treated as final — the subscription is dead for good and the row goes.

`backend/src/push.js` implements RFC 8291 (aes128gcm payload encryption) and
RFC 8292 (VAPID) on `node:crypto` rather than pulling a library in: it is two
HKDF derivations, one AES-GCM record and one ES256 signature. The risk in
hand-writing it is that a wrong derivation fails *silently* — the push service
accepts the body and the browser drops it with no error anywhere — so
`backend/test/push.test.js` holds a real P-256 key pair, subscribes with it, and
decrypts what the watcher sends. The server never sees a readable payload go
out, and neither does the push service: the notification text is sealed to keys
only the browser has.

Client side, `web/sw.js` is woken with no page open, and `web/app.js` owns
everything that needs a session: it registers the worker, re-affirms the
subscription on every visit (which is how one made under another account
follows the account signed in now), and unsubscribes on sign-out. The Chrome
extension deliberately has none of this — extension service workers have no Push
API — and does not need it: `chrome.alarms` already covers the browser being
open, which is the only time an extension can run at all.

## Telling a tracker what was read

The import direction came first — `/api/import` reads a MyAnimeList export,
`/api/export` writes one — which left a tracker able to seed the library and
then never hear from it again. `backend/src/tracker-push.js` is the other half:
when a bookmark advances, AniList and MyAnimeList are told.

This is the only place PanelFlow writes to something the user owns somewhere
else, so it is written to be timid.

- **Progress and nothing else.** No status, no score, no dates. Sending status
  too would drag a COMPLETED or DROPPED entry back to CURRENT the moment an old
  chapter was reopened, and which folder a series is in is already exported
  deliberately, by the user, from `/api/export`.
- **Forward only.** `tracker_links.last_chapter` is what the tracker was last
  told; a lower number is dropped. Rereading chapter 3 of a 200-chapter series
  is the obvious way this feature could destroy something.
- **A guess is never a link.** "Chapitre 109 VF" on a scan site is media 30002
  on AniList, and the bridge between them is a title search scored by
  `shared/series-match.js` — the same rule that decides whether two library
  entries are one work, at the same `STRONG` threshold. Below it the row is
  stored as `unmatched` and the closest hit is kept as the "did you mean?", but
  nothing is sent. `unmatched` is deliberately not retried: a title that simply
  is not in the catalogue would otherwise cost a search on every chapter
  forever. The way out is `PUT /api/trackers/:service/link/:libraryId`, backed
  by `GET /api/trackers/:service/search`.
- **`muted`** is the third state, so one series can be kept off a tracker
  without disconnecting the account.

Connecting a tracker *is* the opt-in — keeping a list current is what a tracker
is for, and disconnecting turns it off, taking the links with it so reconnecting
cannot silently resume pushing to a months-old match.

The push runs **inside** `PUT /api/progress/:libraryId` rather than after the
response, because work that outlives the response is killed with the lambda.
It costs one query for a user who has connected nothing, and one round trip per
*chapter* — not per page — for everyone else, since the link is cached and an
already-sent chapter short-circuits. It cannot throw: a tracker being down is
not a reason to lose a bookmark, and the outcome per service is reported back in
the response instead. `POST /api/trackers/:service/push` backfills a library
that predates the connection, sequentially and on a deadline, because a
backfill that gets the account rate limited has made things worse.

Kitsu is absent here exactly as it is from `/connect`: its OAuth is a
resource-owner password grant nobody has wired up, so there is no token to push
with, and an absent service means "skip", not "fail".

## Getting a tracker's permission

`backend/src/tracker-oauth.js` holds the handshake. The client never sees a
client secret, a code or a token: it asks for an authorisation URL, opens it,
and the tracker comes back to `GET /api/trackers/:service/callback` on the
server, which exchanges the code and stores the tokens. Which user the callback
belongs to travels in the `state` parameter as a short-lived signed token —
the redirect arrives with no session, no cookie and no header.

The three services disagree about nearly everything, and the table in
`SERVICES` is where the disagreement is kept instead of in the flow:

- **AniList** takes JSON, answers with a token good for about a year, and has
  no refresh worth the name. When it expires the only honest thing to do is ask
  for the permission again, so `freshToken` does not pretend otherwise.
- **MyAnimeList** takes form encoding, hands out a token that lasts an hour,
  and requires PKCE — `plain` only, meaning the challenge *is* the verifier.
  Every read refreshes it first when it is within a minute of expiring.
- **Kitsu** is missing on purpose: its OAuth is a resource-owner password grant,
  and PanelFlow does not ask anyone for a tracker password. `GET /services`
  answers `oauth: false` for it so a client can say "not supported" rather than
  "this server is missing a key", which is a different problem with a different
  fix.

A refusal is reported in the tracker's own words rather than as a status code —
`Code expired` is actionable, `502` is not — and the same goes for a refresh
that fails: the row is left alone and the reader is told to connect it again.

A token also reads. `POST /api/import/:service/account` imports the list of
whoever is connected: no username to type, no export file to go and fetch, and
for AniList the signed query returns a private list that the by-name import
cannot see. It is the same write path as the file import — fills holes, never
overwrites — and it deliberately builds the same `sourceUrl` the file import
builds (`https://myanimelist.net/manga/<id>`), because two roads to the same
series that disagree about its key produce two library rows instead of one.

The client half is the same in both places, over the hub messages `trackers`,
`trackerConnect`, `trackerDisconnect`, `trackerSearch`, `trackerLink`,
`trackerUnlink` and `trackerPushAll`. The web app has a Trackers view; the
extension has a popup panel for the accounts and a row per tracker on each
entry sheet for the matching. Connecting opens a **tab**, never a popup window
inside the extension popup, which closes the moment focus leaves it. With
nothing connected, that per-entry row falls back to what it always did: opening
the tracker's own search page for the title.

## Ad blocking

`shared/adblock-list.json` is the list: hosts grouped by what they do, with the
group deciding whether image requests are blocked too (creatives and tracking
pixels yes, an exchange's bid calls no — so a CDN shared with a site's own
artwork cannot be caught by a rule meant for a banner).

Nothing enforces that file directly. `scripts/build-adblock.mjs` (run by `npm
run sync:shared`) translates it into `extension/rules/adblock.json` for Chrome's
declarativeNetRequest and `ios/Resources/blocker-rules.json` for Safari's
`WKContentRuleList`; Android has no rule engine and parses hostnames back out of
Chrome's file. Those three were maintained by hand until 2026-08 and the Safari
list had drifted to 8 of the extension's 20 hosts, which is why they are
generated and why the test suite fails on a hand edit.

Chrome then treats its bundled ruleset as the *fallback*, not the policy:

- `GET /api/adblock` serves the list, flat and versioned, to anyone.
- The service worker installs it as **dynamic** rules and disables the bundled
  ruleset. Only then — a host removed upstream has to actually stop being
  blocked, and it cannot if a static copy is still blocking it.
- If the fetch fails, or comes back with no hosts, the bundled ruleset stays
  enabled. An empty list must never be mistaken for a list that blocks nothing.
- The whitelist is `allowAllRequests` on the whitelisted site's frames, above
  the block rules' priority, applied whichever list is in force.

Chrome's syntax lives in `shared/adblock.js` rather than in the build script,
because the extension builds those same rules at runtime from what it fetched.
The phones ship the generated lists and do not refresh them yet: a list change
reaches them on the store's schedule.

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
