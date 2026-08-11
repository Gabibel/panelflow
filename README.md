# PanelFlow — Manga Reader Browser

A specialized web browser for manga readers. Browse **any** manga site you already
use; compatible reading pages are detected dynamically (no fixed site list) and can
be flipped into a clean, ad-free Reader Mode — while your library, reading progress
and new-chapter alerts follow you across devices.

## Monorepo layout

| Path | What | Status |
|---|---|---|
| `/backend` | Node.js/Express + SQLite API: auth (JWT), library CRUD, progress sync, detection-rules remote config, tracker OAuth proxy | ✅ working, 7 integration tests |
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

## Feature map (from spec)

- **Detection engine** — heuristic scoring (image gallery, URL patterns, chapter nav links, text density) + per-domain rules cached from `/api/rules`; never auto-switches, always shows an opt-in pill. `extension/content/detect.js`
- **Reader Mode** — vertical scroll / LTR / RTL / double-page, tap zones, auto-hide chrome, brightness, preload, and **no-snap-back zoom/pan** (view settles at elastic bounds, only double-tap recenters). `extension/content/reader.js`
- **Adblock** — one list (`shared/adblock-list.json`) generated into a declarativeNetRequest ruleset, a Safari content blocker and the Android host list; the extension replaces its bundled copy with `/api/adblock` at runtime. Plus the popup/redirect hijack guard (`content/popup-guard.js`) and a per-site whitelist.
- **Library & progress** — local-first in `chrome.storage`, synced to backend when signed in; continue-reading deep links.
- **New chapters** — `chrome.alarms` polling of pinned series with polite pacing and `chrome.notifications` alerts, plus a server-side watcher on a Vercel cron for the hours no client is running.
- **Trackers** — backend OAuth proxy for AniList/MAL/Kitsu (client secrets stay server-side), and progress pushed out to AniList/MAL as chapters are read (`backend/src/tracker-push.js`).
- **Accounts/sync** — email+password JWT auth; free = local-only, premium = multi-device sync (billing integration: backlog).

## Backlog (v1 → v1.x)

- APNs/FCM push, so a chapter found server-side reaches a phone that is asleep
- Tracker OAuth end to end (client ids/secrets, refresh, MAL PKCE, Kitsu grant) and a client UI for linking
- Store billing (StoreKit 2 / Play Billing), OAuth sign-in (Apple/Google)
- Native app shells (see `/ios` and `/android` READMEs for the ordered plan)
