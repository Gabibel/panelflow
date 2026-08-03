# mobile/ — the web layer both phone apps run

Neither `android/` nor `ios/` contains a UI. They contain a shell, a bridge and
the four things a web view genuinely cannot do (notifications, background work,
per-request ad blocking, opening another app). Everything else the user sees and
every decision about their library lives here, in JavaScript, shared with the
browser extension.

```
mobile/
  www/            loaded by MainActivity / ShellViewController
    index.html    the app: library, folders, search, account
    app.js        views, state, and window.PanelFlowShell.back()
    app.css
    bridge.js     page → native → worker, and events back
    worker.html   the offscreen worker web view
    worker.js     hosts the shared core, exposes PanelFlowWorker.handle/boot
    shared/       generated copies — see below
  inject/
    chrome-shim.js  the five chrome.* APIs the content scripts use
```

## Two web views, on purpose

The shell renders. The **worker** — an offscreen web view that is never added to
a window — runs `shared/panelflow-core.js` and owns the store.

They are split because `localStorage` belongs to an origin, and the store has to
sit on the same side of the native bridge as the code that mutates it. If the
shell owned the data, every merge would become a dozen async hops through the
message handler; if native owned it, the merge logic would have to be written
twice more, in Kotlin and in Swift, and the three copies would drift. This way
adding a chapter behaves identically in Chrome, on Android and on iOS because it
is the same function.

The worker is the direct counterpart of the extension's MV3 service worker, and
both platforms drive it with the same message protocol:

```
{ id, msg }                 a request
{ reply: { id, body } }     an answer
{ event, ... }              an unprompted push (ready, notify, resumed)
```

One id space, two destinations: replies come either from the worker or from a
page the toolbar asked something of.

## Generated copies

`www/shared/` and the copies Gradle and `bundle-assets.sh` make are **generated**
by `scripts/sync-shared.mjs` from `shared/`. Do not edit them; edit `shared/` and
re-run:

```bash
node scripts/sync-shared.mjs
```

The `shared sources are in sync` test fails if you forget. The duplication is
deliberate — Chrome MV3 content scripts cannot be ES modules and an `.ipa`
cannot reference a file outside itself — but it is duplication a script
maintains and a test guards, never duplication a person keeps in their head.

## Injected scripts

`inject/chrome-shim.js` is the only mobile-specific file in the injection set.
Everything after it — `series-match.js`, `detect.js`, `library-modal.js`,
`reader.js`, `reader.css` — is copied straight out of `extension/content/` and
runs unchanged. If reader behaviour differs between the phone and the browser,
that is a bug in the shim, not a difference in the reader.

## Running it in a browser

`www/index.html` opens directly in Chrome, which is enough to work on layout and
CSS without a device. There is no native bridge there, so `PanelFlow.available`
is `false` and every `send` rejects — the library will be empty and the search
tab will not answer. Anything that needs real data needs a real shell.
