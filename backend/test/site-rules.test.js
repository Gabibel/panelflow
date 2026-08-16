// Which site is this?
//
// The rules file used to be keyed on hostnames, and shipped with exactly one
// entry in it — a fake one. That is the honest outcome of the design: there are
// thousands of scan sites, they rename themselves, and nobody can verify a
// hostname list by hand. Keying on the *engine* instead is what makes the layer
// worth having, so most of this file is about the two ways an engine is
// recognised (a live DOM, and raw markup) and about the one rule that keeps the
// layer safe: a site's own entry always wins, and a miss always falls back to
// the heuristics rather than to nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSite, hostKeys } from '../src/site-rules.js';
import { analyze } from '../src/compat.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const SHIPPED = JSON.parse(read('shared', 'detection-rules.json'));

/** A tiny rules file: one engine, and whatever domains the test needs. */
const rules = (domains = {}) => ({
  engines: {
    demo: {
      detect: ['#readerarea'],
      signature: ['readerarea'],
      rule: { imageContainer: '#readerarea', title: '.entry-title', nextChapter: 'a.next' },
    },
  },
  domains,
});

/** A `(selector) => boolean` standing in for a live DOM holding these elements. */
const dom = (...present) => (sel) => present.includes(sel);

// --- matching a host --------------------------------------------------------

test('a host is looked up as itself, then bare, then by wildcard', () => {
  assert.deepEqual(hostKeys('www.example.com'),
    ['www.example.com', 'example.com', '*.example.com']);
  assert.deepEqual(hostKeys('ww6.reader.example.com'),
    ['ww6.reader.example.com', '*.ww6.reader.example.com', '*.reader.example.com',
      '*.example.com']);
  // A trailing dot is a legal FQDN and the same host.
  assert.deepEqual(hostKeys('EXAMPLE.COM.'), ['example.com', '*.example.com']);
  assert.deepEqual(hostKeys(''), []);
  assert.deepEqual(hostKeys(null), []);
});

test('no wildcard is ever generated for a bare suffix', () => {
  // `*.com` as a key would make one careless entry own a third of the web.
  for (const host of ['example.com', 'a.b.c.example.co.uk', 'localhost']) {
    assert.ok(!hostKeys(host).some((k) => k.split('.').length <= 2 && k.startsWith('*.')),
      `${host} generated a bare-suffix wildcard`);
  }
});

test('a wildcard entry covers the subdomains and the site itself', () => {
  const r = rules({ '*.scan-test.io': { title: 'h1.mine' } });
  for (const host of ['scan-test.io', 'www.scan-test.io', 'ww6.scan-test.io']) {
    const site = resolveSite({ host, rules: r });
    assert.equal(site?.title, 'h1.mine', host);
    assert.equal(site.knownDomain, true, host);
  }
  // And nothing outside it.
  assert.equal(resolveSite({ host: 'scan-test.io.evil.test', rules: r }), null);
});

test('an unrecognised page resolves to nothing at all', () => {
  // Not an empty object: the callers treat null as "the heuristics are on their
  // own here", which is the whole fallback.
  assert.equal(resolveSite({ host: 'nobody.test', rules: rules() }), null);
  assert.equal(resolveSite({ host: 'nobody.test', rules: rules(), ask: dom() }), null);
  assert.equal(resolveSite({ host: 'nobody.test', rules: rules(), html: '<p>hi</p>' }), null);
  assert.equal(resolveSite({}), null);
  assert.equal(resolveSite(), null);
});

// --- recognising an engine --------------------------------------------------

test('an engine is recognised from the live DOM, on a host nobody listed', () => {
  const site = resolveSite({ host: 'never-heard-of-it.test', rules: rules(), ask: dom('#readerarea') });
  assert.equal(site.engine, 'demo');
  assert.equal(site.imageContainer, '#readerarea');
  // The point of the distinction: this is not a site anyone wrote a rule for.
  assert.equal(site.knownDomain, false);
});

test('an engine is recognised from raw markup, where there is no DOM', () => {
  const html = '<div id="readerarea"><img src="/1.jpg"></div>';
  assert.equal(resolveSite({ host: 'never.test', rules: rules(), html }).engine, 'demo');
  assert.equal(resolveSite({ host: 'never.test', rules: rules(), html: '<p>no</p>' }), null);
});

test('a DOM that says no is not second-guessed by the markup', () => {
  // The DOM is the authority — it can see what JavaScript built. Falling back to
  // the markup here would let the string "readerarea" in an inline script claim
  // a page whose reader is something else entirely.
  const site = resolveSite({
    host: 'never.test',
    rules: rules(),
    ask: dom('.something-else'),
    html: '<script>var readerarea = 1;</script>',
  });
  assert.equal(site, null);
});

test('a selector the rules file got wrong costs its engine, not the scan', () => {
  const broken = {
    engines: {
      bad: { detect: ['::::'], rule: { title: 'h1' } },
      demo: rules().engines.demo,
    },
    domains: {},
  };
  const ask = (sel) => {
    if (sel === '::::') throw new SyntaxError('not a selector');
    return sel === '#readerarea';
  };
  assert.equal(resolveSite({ host: 'x.test', rules: broken, ask }).engine, 'demo');
});

// --- a site's own entry -----------------------------------------------------

test('a domain entry overrides its engine and inherits the rest', () => {
  const site = resolveSite({
    host: 'special.test',
    rules: rules({ 'special.test': { title: 'h1.series', readingDirection: 'rtl' } }),
    ask: dom('#readerarea'),
  });
  assert.equal(site.title, 'h1.series', 'the site was not allowed to disagree with its engine');
  assert.equal(site.readingDirection, 'rtl');
  assert.equal(site.imageContainer, '#readerarea', 'the engine was not inherited');
  assert.equal(site.engine, 'demo');
  assert.equal(site.knownDomain, true);
});

test('a domain entry can name its engine outright', () => {
  // For the site whose markup gives nothing away until JavaScript has run.
  const site = resolveSite({
    host: 'quiet.test',
    rules: rules({ 'quiet.test': { engine: 'demo' } }),
  });
  assert.equal(site.engine, 'demo');
  assert.equal(site.imageContainer, '#readerarea');
});

test('naming an engine that does not exist falls back rather than breaking', () => {
  const site = resolveSite({
    host: 'typo.test',
    rules: rules({ 'typo.test': { engine: 'madra', title: 'h1' } }),
    ask: dom('#readerarea'),
  });
  assert.equal(site.engine, 'demo', 'a typo in one key threw the whole entry away');
  assert.equal(site.title, 'h1');
});

// --- what the file actually ships -------------------------------------------

test('every shipped engine can be recognised both ways and says something useful', () => {
  const ids = Object.keys(SHIPPED.engines || {});
  assert.ok(ids.length >= 4, 'the engines map is where the per-site layer lives');
  for (const id of ids) {
    const e = SHIPPED.engines[id];
    assert.ok(e.detect?.length, `${id} cannot be recognised from a DOM`);
    assert.ok(e.signature?.length, `${id} cannot be recognised from markup`);
    // A rule that names nothing is a rule that changes nothing.
    assert.ok(Object.keys(e.rule || {}).length, `${id} carries no selectors`);
    // Every field has to be one detect.js or reader.js actually reads. Shipping
    // config nobody consumes is how the old per-domain layer became decorative.
    for (const key of Object.keys(e.rule)) {
      assert.ok(
        ['imageContainer', 'title', 'nextChapter', 'prevChapter', 'readingDirection'].includes(key),
        `${id}.${key} is not a field anything reads`);
    }
    // Recognising the engine must not clear the threshold on its own.
    assert.ok(SHIPPED.heuristics.weights.knownEngine < SHIPPED.heuristics.weights.knownDomain);
    assert.ok(SHIPPED.heuristics.weights.knownEngine < SHIPPED.heuristics.scoreThreshold + 10);
  }
});

// The URL signal is worth 20 of the 50 needed, and on a site nobody has listed
// it is often the difference between a reader that opens and a page that looks
// like any other. It has to fire on the permalink shape these sites actually
// use — `/kingdom-chapitre-883/`, no `/manga/` segment anywhere — which is what
// a leading `/` in the pattern quietly excluded.
test('the shipped URL patterns fire on the permalinks these sites really serve', () => {
  const hits = (path) => SHIPPED.heuristics.urlPatterns
    .some((p) => new RegExp(p, 'i').test(path));
  for (const path of ['/kingdom-chapitre-883/', '/one-piece-chapter-1100/',
    '/solo-leveling_ch-179/', '/tower-of-god-episode-600/',
    '/manga/ao-no-hako/chapitre-109', '/read/12/']) {
    assert.ok(hits(path), `${path} scores nothing on its URL`);
  }
  for (const path of ['/', '/a-propos/', '/recherche?q=kingdom', '/tags/seinen/']) {
    assert.ok(!hits(path), `${path} is not a chapter and must not score`);
  }
});

test('detect.js falls back to the same URL patterns it is shipped', () => {
  // The extension carries a copy for the first load, before /api/rules answers.
  // Two spellings of "what a chapter URL looks like" is one spelling nobody
  // tests, so the fallback has to be a subset of the shipped list, verbatim.
  const src = read('extension', 'content', 'detect.js');
  const fallback = src.slice(src.indexOf('urlPatterns: ['), src.indexOf('navTextPatterns'));
  const found = fallback.match(/'([^']+)'/g) || [];
  assert.ok(found.length >= 3, 'the fallback list moved — this test just stopped checking anything');
  for (const p of found) {
    const pattern = p.slice(1, -1).replace(/\\\\/g, '\\');
    assert.ok(SHIPPED.heuristics.urlPatterns.includes(pattern),
      `the fallback matches ${pattern}, which the shipped rules no longer do`);
  }
});

test('every shipped domain entry names an engine that exists', () => {
  for (const [host, entry] of Object.entries(SHIPPED.domains || {})) {
    if (!entry.engine) continue;
    assert.ok(SHIPPED.engines[entry.engine], `${host} runs on "${entry.engine}", which is not an engine`);
  }
});

test('the shipped engines recognise the markup they were written for', () => {
  const pages = {
    madara: '<div class="reading-content"><img class="wp-manga-chapter-img" src="/1.jpg"></div>',
    themesia: '<div id="readerarea"><img class="ts-main-image" src="/1.jpg"></div>',
    manganato: '<div class="container-chapter-reader"><img src="/1.jpg"></div>',
    foolslide: '<div id="page"><div class="inner"><img src="/1.jpg"></div></div>'
      + '<script src="/foolslide/reader.js"></script>',
  };
  for (const [engine, html] of Object.entries(pages)) {
    assert.equal(resolveSite({ host: 'unknown.test', rules: SHIPPED, html })?.engine, engine, html);
  }
  // And leave an ordinary page alone.
  assert.equal(resolveSite({ host: 'unknown.test', rules: SHIPPED, html: '<p>an article</p>' }), null);
});

// --- what the rest of the code does with it ---------------------------------

test('recognising the engine moves a verdict without deciding it', () => {
  const html = '<div class="reading-content"><img class="wp-manga-chapter-img" src="/1.jpg"></div>';
  const plain = analyze(html, 'https://unknown.test/x');
  const known = analyze(html, 'https://unknown.test/x', { rules: SHIPPED });
  assert.equal(known.engine, 'madara');
  assert.equal(plain.engine, null);
  assert.ok(known.score > plain.score);
  // One page image is not a chapter, whatever built it.
  assert.equal(known.verdict, 'unlikely');
  assert.ok(known.signals.includes('known-engine'));
  assert.ok(!known.signals.includes('known-domain'));
});

test('both detectors ask shared/site-rules.js which site this is', () => {
  // The failure this guards is quiet: a hand-written `rules.domains[hostname]`
  // works on the one site it was tested against and knows nothing about
  // wildcards, `www.`, or engines — so the layer silently goes back to being a
  // list of hostnames nobody maintains.
  for (const file of ['extension/content/detect.js', 'shared/compat.js']) {
    const source = read(...file.split('/'));
    assert.ok(/PanelFlowSites/.test(source), `${file} does not consult site-rules.js`);
    assert.ok(!/\.domains\s*\[/.test(source), `${file} indexes domains itself`);
  }
});

test('site-rules.js is loaded everywhere the two detectors run', () => {
  const manifest = read('extension', 'manifest.json');
  const js = JSON.parse(manifest).content_scripts.flatMap((s) => s.js);
  assert.ok(js.indexOf('shared/site-rules.js') > -1, 'the extension never loads it');
  assert.ok(js.indexOf('shared/site-rules.js') < js.indexOf('content/detect.js'),
    'detect.js is injected before the file it asks');

  // Same order on the phones, where the shells hand-maintain the list.
  const kotlin = read('android/app/src/main/java/dev/panelflow/PageScripts.kt');
  const swift = read('ios/Sources/PageScripts.swift');
  assert.ok(kotlin.indexOf('site-rules.js') < kotlin.indexOf('inject/detect.js'));
  assert.ok(swift.indexOf('"site-rules"') < swift.indexOf('"detect"'));

  // And in the worker WebView, where compat.js is the caller.
  const worker = read('mobile/www/worker.html');
  assert.ok(worker.indexOf('shared/site-rules.js') > -1, 'the worker never loads it');
  assert.ok(worker.indexOf('shared/site-rules.js') < worker.indexOf('shared/compat.js'));

  // The backend's ESM face has the same ordering problem, expressed as imports.
  // Matched on the import statements, not the names: both files are mentioned in
  // the comment above them, in the other order.
  const face = read('backend/src/compat.js');
  assert.ok(face.indexOf("import '../../shared/site-rules.js'")
    < face.indexOf("import '../../shared/compat.js'"),
  'backend/src/compat.js loads compat before the file it asks');
});

test('nobody asks compat.js for a verdict without handing it the rules', () => {
  // `analyze(html, url)` is a valid call and answers with generic heuristics, so
  // a caller that forgets the rules gets a plausible-looking wrong answer.
  for (const file of ['backend/src/routes/meta.js', 'backend/src/routes/search.js',
    'mobile/www/worker.js']) {
    assert.match(read(...file.split('/')), /analyze\([\s\S]{0,160}?\{\s*rules\b/,
      `${file} calls analyze() without the rules file`);
  }
});
