# PanelFlow — Manga Reader Browser

A specialized web browser for manga readers. Browse **any** manga site you already
use; compatible reading pages are detected dynamically (no fixed site list) and can
be flipped into a clean, ad-free Reader Mode — while your library, reading progress
and new-chapter alerts follow you across devices.

## Monorepo layout

| Path | What | Status |
|---|---|---|
| `/backend` | Node.js/Express + SQLite API: auth (JWT), library CRUD, progress sync, detection-rules remote config, tracker OAuth proxy | ✅ working, 507 integration tests |
| `/extension` | Chrome MV3: detection engine, Reader Mode, adblock (declarativeNetRequest), popup library, options | ✅ working, load unpacked |
| `/web` | Web frontend (vanilla JS, MangaPin-style): auth, library grid with Reading/Paused/Plan/Complete tabs, continue-reading shelf | ✅ served by backend at `:8787` |
| `/shared` | Detection rules (remote config payload) + JSON Schemas for library/progress | ✅ |
| `/ios` | Swift/WKWebView skeleton (reuses the extension's JS core via WKUserScript) | 🚧 sketches |
| `/android` | Kotlin/WebView skeleton (same shared JS core) | 🚧 sketches |
| `/docs` | Architecture, resilience & store-compliance notes | ✅ |

**Key architectural bet:** the detection engine and Reader Mode are plain JS
(`/extension/content/detect.js`, `reader.js`). Chrome runs them as content scripts;
iOS and Android inject the *same files* into their WebViews through a small
`chrome.runtime → native bridge` shim. One heuristics engine, four platforms, and
extraction rules update server-side without app-store releases.

## Quick start

### Backend
```bash
cd backend
npm install
npm test          # integration suite (in-process server, temp DB)
npm start         # listens on :8787
```

### Web frontend

Served by the backend: start it, then open <http://localhost:8787/>. Sign up,
then add series manually or pin them from the extension — the library is shared.
Reading status (Reading / Paused / Plan / Complete / Dropped) is the `folder`
column on the library entry, and every client reads and writes that one field.
It used to be a `status:<x>` tag; the boot migration promotes those tags into
the column the first time it appears, so nothing was lost.

### Chrome extension
1. `chrome://extensions` → Developer mode → **Load unpacked** → select `/extension`
2. Open any manga chapter page; when detected, a "📖 Reader Mode" pill appears bottom-right.
3. Popup (toolbar icon) = library + continue reading. Options page = account, backend URL, adblock whitelist, default reading mode.

It talks to the deployed backend out of the box. To work against a server of
your own, put `http://localhost:8787` in *API URL* on the options page and sign
in again — a token minted by one is not valid on the other.

## Feature map (from spec)

- **Detection engine** — heuristic scoring (image gallery, URL patterns, chapter nav links, text density) + per-domain rules cached from `/api/rules`; never auto-switches, always shows an opt-in pill. `extension/content/detect.js`
- **Reader Mode** — vertical scroll / LTR / RTL / double-page, tap zones, auto-hide chrome, brightness, preload, and **no-snap-back zoom/pan** (view settles at elastic bounds, only double-tap recenters). `extension/content/reader.js`
- **Adblock** — one list (`shared/adblock-list.json`) generated into a declarativeNetRequest ruleset, a Safari content blocker and the Android host list; the extension replaces its bundled copy with `/api/adblock` at runtime. Plus the popup/redirect hijack guard (`content/popup-guard.js`) and a per-site whitelist.
- **Library & progress** — local-first in `chrome.storage`, synced to backend when signed in; continue-reading deep links.
- **New chapters** — `chrome.alarms` polling of pinned series with polite pacing and `chrome.notifications` alerts, plus a server-side watcher on a Vercel cron for the hours no client is running, plus Web Push (`backend/src/push.js`, `web/sw.js`) so what the cron finds overnight reaches a browser that is closed. Encryption is RFC 8291/8292 on `node:crypto`, no dependency; run `node scripts/vapid-keys.mjs` once and set the three `PANELFLOW_VAPID_*` variables.
- **Trackers** — AniList and MyAnimeList connected through a backend OAuth proxy (client secrets and tokens stay server-side; MAL is refreshed before every use), progress pushed out as chapters are read (`backend/src/tracker-push.js`), and a screen in both clients to connect an account, fix a wrong match, mute a series, backfill the whole library or import the tracker's list straight from the connection. Kitsu only offers a password grant, so it is deliberately not connected.
- **Accounts/sync** — email+password JWT auth; free = local-only, premium = multi-device sync (billing integration: backlog).

## Backlog (v1 → v1.x)

The ordered, task-by-task version of this list lives in [`docs/roadmap.md`](docs/roadmap.md),
along with the repo invariants any change has to respect. The measured gap against
the competitor it is written against is in [`docs/comparatif-a-b.md`](docs/comparatif-a-b.md).

- APNs/FCM push for the native shells — the web app has Web Push, but a phone app asleep on iOS reaches neither
- Store billing (StoreKit 2 / Play Billing), OAuth sign-in (Apple/Google)
- Native app shells (see `/ios` and `/android` READMEs for the ordered plan)
