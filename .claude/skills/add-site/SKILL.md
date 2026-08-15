---
name: add-site
description: Add support for a scan site — identify its reader engine, add the rule, cover it with a test. Use when a site does not open in the reader, or when asked to support a new site.
disable-model-invocation: true
---

# Adding a site

The site to add is in `$ARGUMENTS` — a hostname or a chapter URL. If it is empty, ask for one before doing anything else.

## The rule that shapes all of this

**Add an engine, not a hostname.** There are thousands of scan sites, they rename themselves every few months, and a hostname list is a list nobody can verify. `shared/detection-rules.json` has two sections and they are not equal:

- `engines` — keyed on the reader software (`madara`, `themesia`, `manganato`, `foolslide`). One entry covers every site running it, including the ones that do not exist yet. **This is where a new site should almost always go.**
- `domains` — per-host overrides, wildcards like `*.example.com`. Only for a site whose markup is genuinely its own, or one running a known engine with one selector changed.

A site's own `domains` entry always wins over its engine; a miss falls back to the generic heuristics rather than to nothing. So a wrong entry degrades, it does not break — but a hostname entry where an engine entry belonged is work that expires.

## Step 1 — get the markup

You need the chapter page's HTML. Try, in order:

```bash
curl -sL --max-time 20 -A "Mozilla/5.0" "<chapter-url>" -o "$TMP/site.html" && wc -c "$TMP/site.html"
```

**A failure here means nothing about the site.** Kaspersky and Cloudflare block roughly a third of scan sites from this machine — see the `verifying-scan-sites-from-this-machine` memory. Tell them apart:

- Empty response, connection reset, or a Kaspersky interstitial → the local machine refused, not the site.
- HTTP 403 with a Cloudflare challenge page → the site is up and defending itself.

Either way, do not report the site as dead. Say which of the two you hit, and ask the user to paste the page source (their browser has no such problem). Then continue with what they paste.

## Step 2 — identify the engine

Look for the markers the existing entries use — a container class, a reader wrapper id:

```bash
grep -oE 'class="[^"]*(reading-content|readerarea|container-chapter-reader|entry-content)[^"]*"' "$TMP/site.html" | sort -u | head
```

Compare against `shared/detection-rules.json`:

- **Marker already listed under an engine** → the engine covers it. There may be nothing to add at all; verify with a test (step 4) and stop. This is the best outcome and it is common.
- **Marker unlisted, but the layout matches a known engine's shape** → add the marker to that engine's `detect` and `signature` arrays.
- **Genuinely different markup** → new engine entry, keyed on the software if you can name it (view-source often has a generator meta, a theme path, or a plugin URL), or a `domains` entry if you cannot.

An engine entry has this shape — `detect` is queried against a live DOM, `signature` is matched against raw markup, and both must identify the same thing:

```json
"engine-name": {
  "detect": [".reader-container", ".chapter-heading"],
  "signature": ["reader-container", "chapter-heading"],
  "rule": {
    "imageContainer": ".reader-container",
    "title": ".chapter-heading h1",
    "nextChapter": "a.next-chapter",
    "prevChapter": "a.prev-chapter"
  }
}
```

`detect` selectors must be specific enough that a random blog does not match them. Two markers are better than one, and the reader container plus the chapter title is the usual pair.

## Step 3 — edit the source, never a copy

Edit **`shared/detection-rules.json`** only. Bump `version` and set `updatedAt` to today: clients cache the rules for six hours (`RULES_TTL_MS` in `shared/panelflow-core.js`) and read them from `/api/rules`, so the file is the deploy — no extension update, no app-store release. Do not touch `filterListVersion`; the server derives it.

If the change also touched a `shared/*.js` file, the PostToolUse hook re-runs `npm run sync:shared` for you. The generated copies under `extension/shared/`, `mobile/www/shared/` and `web/shared/` are refused by a guard if you try to edit them directly.

## Step 4 — a test, in the same commit

`backend/test/site-rules.test.js` is the file. It builds its own tiny rules objects rather than asserting against the shipped ones, so follow the local idiom (`rules()`, `dom()`) instead of inventing a fixture directory — there isn't one.

Cover the two ways the engine gets recognised, since they are separate code paths:

```js
test('<engine> is recognised from a live DOM', () => {
  const site = resolveSite({ host: 'example.com', rules: SHIPPED, has: dom('.reader-container') });
  assert.equal(site.engine, 'engine-name');
});

test('<engine> is recognised from raw markup', () => {
  const site = resolveSite({ host: 'example.com', rules: SHIPPED, html: '<div class="reader-container">' });
  assert.equal(site.engine, 'engine-name');
});
```

Read the neighbouring tests first and match their call signature — `resolveSite` takes an options object and the exact keys matter more than what is written here.

Then run the suite. It is about ten seconds and it also checks that the JSON is well-formed and that every client still loads `site-rules.js` before the detector that asks it:

```bash
npm test
```

## Step 5 — report honestly

Say which of these actually happened:

- the engine already covered the site (no rule added), or
- a marker was added to an existing engine, or
- a new engine or domain entry was added,

and whether you verified against **real markup** or against markup the user pasted, or could not fetch it at all. A rule written from a guess is worth having only if it is labelled as one.
