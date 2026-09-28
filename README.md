# PanelFlow

**Read manga, webtoons and novels on the sites you already use, keep track of
your anime, and have one library that follows you everywhere.**

PanelFlow is a reading mode, not a catalogue. You browse the sites you already
read on; when a page is a chapter, PanelFlow offers to open it in a clean,
ad-free reader. Your library, where you stopped, what you read and watched,
and which series have a new chapter are the same on the Chrome extension, the
website and the phone app, and your progress can be sent to AniList and
MyAnimeList as you go.

> **New here?** [`docs/ONBOARDING.md`](docs/ONBOARDING.md) is the map of the
> repo, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) says why it is built
> this way, and [`docs/DEBUG.md`](docs/DEBUG.md) turns a symptom into a file.
> Installing the extension by hand: [`docs/installation.md`](docs/installation.md).
> The phone app on a real iPhone: [`docs/tester-sur-iphone.md`](docs/tester-sur-iphone.md).
> The texts for the Chrome Web Store and the App Store:
> [`docs/store-listing.md`](docs/store-listing.md).

---

## What it does

### Reading

- **Works on the sites you already use.** Chapter pages are recognised from
  what they contain (a run of page images, chapter links, the address), with
  per-site rules updated from the server without a new release. Nothing
  switches by itself unless you ask it to: a small pill offers the reader.
- **A clean reader** for manga, webtoons and novels:
  - long strip, single page or double page, left-to-right or right-to-left;
  - a text mode for web and light novels, with its own column width.
- **Comfortable to read with:**
  - zoom and pan that stay where you leave them, and a double tap to zoom;
  - tap zones, brightness and strip width;
  - full screen;
  - auto-scroll for long strips, with a speed you choose;
  - keyboard shortcuts, listed with `?`;
  - controls that hide while you read.
- **Chapter to chapter without leaving the reader:**
  - previous and next in place, and a chapter wheel (`C`) showing what you read;
  - a panel at the end of each chapter;
  - an optional "go on to the next chapter".
- **Settings per series:** a webtoon can stay in long strip while a manga
  reads right to left, without changing modes each time.
- **Pages load ahead of you**, including on sites that show one page per
  address.
- **Offline reading** (extension): keep a chapter to read without the site.
- **Fewer interruptions:**
  - ads blocked on reading sites (declarativeNetRequest), with a per-site
    whitelist;
  - a guard against pop-up tabs and redirect hijacks.

### Watching

- **A speed control on video players** (0.5× to 4×) for the streaming sites
  you turn on, or on every site with the "all sites" permission. It sits on
  the player's corner and folds into a dot. If you hid it on a site, the
  popup brings it back.
- **Add an anime to your library from its episode page** with the 🔖 on the
  bar. The series, the season and the episode are read from the page:
  - from its structured data where it publishes it (Crunchyroll and other
    licensed platforms);
  - otherwise from its title, address and episode picker.
- **Each season is its own entry**, as it is on AniList and MyAnimeList.
- **Episodes you really watched count:** two minutes of playback, not an
  opened tab, go into your history and statistics.

### Your library

- **Every medium**, with filters: manga, webtoons, web novels, light novels
  and anime. Anime counts episodes, not chapters, everywhere.
- **Folders** (reading, paused, plan to read, completed, dropped), plus:
  - scores, notes and tags;
  - start and finish dates, and rereads.
- **Continue where you stopped**, from the popup, the website or the phone.
- **One entry per series:**
  - the same series found on another site is recognised, and you are asked
    before anything is merged;
  - a series can be moved to another site, keeping your progress.
- **New chapters:**
  - checked in the background, with a notification;
  - checked on the server while every device is off, with Web Push to reach a
    browser that is closed;
  - an "updates" feed.
- **History and statistics** by medium and overall:
  - chapters or episodes, time spent, and the average per day;
  - reading streaks, and the series you spent the most time on.
- **Your sites:** the sites your library comes from, a click away.

### Trackers

- **AniList and MyAnimeList** are connected through OAuth. Tokens and client
  secrets stay on the server.
- **Progress is sent as you read or watch**, and it only ever moves forward.
  The link is chosen carefully:
  - the right catalogue (anime or manga);
  - the right format (a light novel is not its manga adaptation);
  - the right season.
  A title that is not a sure match is never guessed: you pick it.
- **From the series sheet:**
  - add a series to a tracker;
  - fix a wrong match, or mute a series;
  - backfill the whole library;
  - import your tracker's list.
  Removing a series from the library offers to remove it from the tracker too.

### Account, sync and privacy

- **Local-first.** Everything works without an account, on one device. An
  account (email and password) syncs the library, progress, settings and
  theme across the extension, the website and the phone app.
- **Account self-service:** forgotten password, change of email and account
  deletion, from every client.
- **Your data:**
  - a full export (GDPR), from the settings;
  - no analytics or advertising SDK;
  - logs pseudonymised;
  - [privacy policy](web/privacy.html) and legal pages built into each client.
- **French and English**, with light, dark or system theme.
- "Report a problem" from any client.

---

## The clients

| Client | What it is |
|---|---|
| **Chrome extension** (`/extension`) | Manifest V3. Reader, detection, video bar, popup (library, updates, statistics, your sites), options, first-run tour. |
| **Website** (`/web`) | Served by the backend. Library, updates, sites, statistics, history, trackers, settings. It also lets you change the extension's settings. |
| **Phone app** (`/native`) | Expo / React Native for iPhone and Android. An in-app browser with the same reader, and the library, history, statistics, trackers and new-chapter checks. The store build leaves out the video bar and offline chapters (see `docs/ARCHITECTURE.md`, "Store compliance"). |
| **Backend** (`/backend`) | Node.js / Express on libsql (SQLite locally, Turso in production), deployed on Vercel. Auth, sync, rules, tracker OAuth proxy, new-chapter watcher (cron), Web Push, mail. |

**Key architectural bet:** detection, the reader and every library rule are
plain JavaScript written once (`shared/`, `extension/content/`). Chrome runs
them as content scripts; the phone injects the same files into its WebView
through a small `chrome.* → native` shim. One engine, every platform, and
extraction rules updated server-side without store releases.

## Monorepo layout

| Path | What |
|---|---|
| `/backend` | API, database, cron and push. Tests in `backend/test` (unit and integration, plus end-to-end in a real Chromium under `test/e2e`). |
| `/extension` | Chrome MV3 extension. `content/detect.js` (detection), `content/reader.js` (reader), `content/video-speed.js` (video bar), `background.js` (worker). |
| `/web` | Website, vanilla JS, served by the backend. |
| `/native` | Expo / React Native phone app. |
| `/mobile` | The phone's web shell and the scripts injected into its browser. |
| `/shared` | The core shared by every client: `panelflow-core.js`, `series-match.js`, `site-rules.js`, `detection-rules.json`, locales. Copied into each client by `npm run sync:shared`. Never edit the copies. |
| `/ios`, `/android` | Swift and Kotlin shells (sketches, see their READMEs). |
| `/docs` | Architecture, onboarding, debugging, deployment, store notes. |

## Quick start

```bash
npm install
npm test                # every unit and integration test (backend workspace)
npm run sync:shared     # after editing anything under shared/
npm run pack            # dist/panelflow-<version>.zip, the extension as shipped
```

### Backend and website

```bash
cd backend
npm start               # http://localhost:8787, the website included
```

Deploying: [`docs/deploy-vercel.md`](docs/deploy-vercel.md).

### Chrome extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `/extension`
   (or unzip `dist/panelflow-<version>.zip` and load that folder).
2. Open a chapter page on a site you read on: a "📖" pill offers the reader.
3. For PanelFlow to work on the most sites, turn on "all sites" in the
   settings; streaming sites can also be turned on one at a time from the popup.

It talks to the deployed backend out of the box. To use your own server, set
*API URL* in the options to `http://localhost:8787` and sign in again.

### End-to-end tests

```bash
cd backend
PANELFLOW_E2E_CHROMIUM=/path/to/chrome node --test test/e2e/*.e2e.test.js
```

## Roadmap

The ordered backlog and the rules every change keeps are in
[`docs/roadmap.md`](docs/roadmap.md). Next up: store submissions (Chrome Web
Store, App Store), push notifications for the phone app (APNs / FCM), and
Apple / Google sign-in.
