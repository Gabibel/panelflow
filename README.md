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
Reading status (Reading / Paused / Plan / Complete) is stored as a `status:<x>`
tag on the library entry, so every client sees it without a schema change.

### Chrome extension
1. `chrome://extensions` → Developer mode → **Load unpacked** → select `/extension`
2. Open any manga chapter page; when detected, a "📖 Reader Mode" pill appears bottom-right.
3. Popup (toolbar icon) = library + continue reading. Options page = account, backend URL, adblock whitelist, default reading mode.

## Feature map (from spec)

- **Detection engine** — heuristic scoring (image gallery, URL patterns, chapter nav links, text density) + per-domain rules cached from `/api/rules`; never auto-switches, always shows an opt-in pill. `extension/content/detect.js`
- **Reader Mode** — vertical scroll / LTR / RTL / double-page, tap zones, auto-hide chrome, brightness, preload, and **no-snap-back zoom/pan** (view settles at elastic bounds, only double-tap recenters). `extension/content/reader.js`
- **Adblock** — static declarativeNetRequest ruleset v1 (`extension/rules/adblock.json`) + popup/redirect hijack guard (`content/popup-guard.js`) + per-site whitelist. Safari content-blocker mirror in `/ios/Resources`.
- **Library & progress** — local-first in `chrome.storage`, synced to backend when signed in; continue-reading deep links.
- **New chapters** — `chrome.alarms` polling of pinned series with polite pacing; `chrome.notifications` alerts. (Server-side watcher: backlog.)
- **Trackers** — backend OAuth proxy endpoints for AniList/MAL/Kitsu (client secrets stay server-side).
- **Accounts/sync** — email+password JWT auth; free = local-only, premium = multi-device sync (billing integration: backlog).

## Backlog (v1 → v1.x)

- Offline chapter downloads (extension: `chrome.downloads`; mobile: native)
- Server-side chapter watcher + APNs/FCM push
- Dynamic filter-list pipeline (EasyList subset compiler → remote config)
- Tracker progress push on chapter completion
- Store billing (StoreKit 2 / Play Billing), OAuth sign-in (Apple/Google)
- Native app shells (see `/ios` and `/android` READMEs for the ordered plan)
