// The site registry: which of the domains this project claims are alive, and
// on which of them the reader would actually open.
//
// `shared/detection-rules.json` lists ~270 domains, and its own comments admit
// that many were "listed from knowledge, not visited". The audit of
// 2026-09-18 put it plainly: an entry in the manifest proves neither
// detection nor loading. This script goes and looks, and writes what it found
// with the date, so the claim becomes a record.
//
// For every domain, two questions, and at most three requests:
//
//   1. Does it answer? The home page is fetched with a browser's headers and
//      a short timeout. The answer is one of: `ok`, `challenge` (Cloudflare's
//      "just a moment", which is a wall and not a page), `moved` (it answered
//      from another host: the domain in the list is stale), `http:<status>`,
//      or `error:<code>` (DNS, timeout, reset).
//   2. Would the reader open a chapter there? Only for `ok` reading sites: a
//      chapter page is fetched and handed to shared/compat.js, the same
//      analysis the reader runs, and its verdict is recorded with the image
//      count. The chapter is found in this order: an address written by hand
//      in docs/sites-samples.json (a site someone opened in a browser and
//      noted), else the first chapter-shaped link on the home page, else the
//      first chapter-shaped link on the first series-shaped page the home
//      page links to (one more request; catalogue sites link series, not
//      chapters). A site where none of the three finds a chapter is recorded
//      as `no-sample`, which is a fact too.
//
// Writes docs/sites-registry.json (the record) and docs/sites-registry.md (the
// same, readable). Both are committed: the point is the history. A domain
// that was `ok` in September and `error:ENOTFOUND` in December is a domain to
// remove, and one that is `challenge` from this machine may be fine from a
// phone (the note below the table says so).
//
//   node scripts/check-sites.mjs            # everything, ~4 minutes
//   node scripts/check-sites.mjs voiranime  # only domains containing that
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(readFileSync(join(root, 'shared', 'detection-rules.json'), 'utf8'));

// Chapter addresses found by hand, by domain. For a site whose pages are
// built in JavaScript, or whose home page links only series, this is the one
// way the registry gets a chapter to look at. The file says how it was found.
const samplesPath = join(root, 'docs', 'sites-samples.json');
const samples = existsSync(samplesPath) ? JSON.parse(readFileSync(samplesPath, 'utf8')) : {};

// The reader's own analysis and the challenge detector, through the server's
// ESM faces so this script needs no globals set up by hand.
const { analyze } = await import('../backend/src/compat.js');
const { challengePage } = await import('../backend/src/panelflow-core.js');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const TIMEOUT_MS = 15000;
const PARALLEL = 8;

/** A page, or a reason there is none. Never throws. */
async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'fr,en;q=0.8' },
    });
    const html = (await resp.text()).slice(0, 1_500_000);
    return { status: resp.status, url: resp.url, html };
  } catch (e) {
    // One word per cause. Two of them are the same fact from two layers:
    // our abort after TIMEOUT_MS and undici's own connect timeout are both
    // "nothing answered in time", and from this machine that usually means
    // the antivirus or the ISP sits in front of the site, not that the site
    // is gone. A phone on another network may see it fine.
    const code = e?.cause?.code || e?.code || e?.name || '';
    if (e?.name === 'AbortError' || /TIMEOUT/i.test(code)) return { error: 'timeout' };
    if (/CERT|SELF_SIGNED/.test(code)) return { error: 'certificate' };
    return { error: code || String(e).slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

const siteOf = (host) => host.replace(/^www\./, '').split('.').slice(-2).join('.');

/** The first link on a page that looks like a chapter, on the same site. */
function sampleLink(html, base) {
  const host = new URL(base).hostname;
  const seen = new Set();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (siteOf(u.hostname) !== siteOf(host) || seen.has(u.href)) continue;
    seen.add(u.href);
    if (/(chapter|chapitre|\/ch[-_]?\d|\/read\/|\/lecture|\/scan[-_]|episode|\/ep[-_]?\d)/i.test(u.pathname)) return u.href;
  }
  return null;
}

/** The first link on a page that looks like a series index, on the same site. */
function seriesLink(html, base) {
  const host = new URL(base).hostname;
  for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (siteOf(u.hostname) !== siteOf(host)) continue;
    // A series path has a slug after its section; a bare section is the list.
    if (/^\/(manga|series|comic|comics|title|titles|book|novel|webtoon|comics?|read|truyen|manhwa|manhua)\/[^/]+\/?$/i.test(u.pathname)) return u.href;
  }
  return null;
}

/**
 * Where a chapter of this site is, and how it was found: `hand` (the samples
 * file), `home` (linked from the home page) or `series` (linked from the
 * first series page the home page links to). Null when nothing found one.
 */
async function findSample(domain, home) {
  const hand = samples[domain]?.url;
  if (hand) return { url: hand, via: 'hand' };
  if (!home.html) return null;
  const fromHome = sampleLink(home.html, home.url);
  if (fromHome) return { url: fromHome, via: 'home' };
  const series = seriesLink(home.html, home.url);
  if (!series) return null;
  const page = await fetchPage(series);
  if (page.error || page.status >= 400 || challengePage(page.html)) return null;
  const fromSeries = sampleLink(page.html, page.url);
  return fromSeries ? { url: fromSeries, via: 'series' } : null;
}

/**
 * For a video site: an episode page, and whether the video bar would have
 * anything to sit on. The page is judged the way video-speed.js judges a
 * page whose host it does not know: a <video>, a player in a frame from a
 * host the rules list, or an episode picker. `player` means one of those was
 * found; `no-player` that an episode page answered and held none of them in
 * its markup (a player written by JavaScript, or a wall); `no-sample` that no
 * link on the home page looked like an episode.
 */
const EPISODE_LINK = /(episode|\/watch\/|\/ep[-_]?\d|\/anime\/[^/]+\/[^/]+|\/saison|\/season)/i;
const EPISODE_OPTION = /<option[^>]*>\s*(?:episode|épisode|ep)\.?\s*\d+/i;
const PLAYER_HOSTS = Object.keys(rules.videoDomains || {}).filter((k) => !k.startsWith('_'));

async function episodeVerdict(domain, home) {
  const hand = samples[domain]?.url;
  let url = hand || null;
  if (!url && home.html) {
    const host = new URL(home.url).hostname;
    for (const m of home.html.matchAll(/href=["']([^"'#]+)["']/gi)) {
      let u;
      try { u = new URL(m[1], home.url); } catch { continue; }
      if (siteOf(u.hostname) !== siteOf(host)) continue;
      if (EPISODE_LINK.test(u.pathname)) { url = u.href; break; }
    }
  }
  if (!url) return { sample: null, verdict: 'no-sample' };
  const page = await fetchPage(url);
  const row = { sample: url, sampleVia: hand ? 'hand' : 'home' };
  if (page.error || page.status >= 400) return { ...row, verdict: `sample-${page.error ? `error:${page.error}` : `http:${page.status}`}` };
  if (challengePage(page.html)) return { ...row, verdict: 'sample-challenge' };
  const frames = [...page.html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => {
    try { return new URL(m[1], page.url).hostname.replace(/^www\./, ''); } catch { return ''; }
  });
  const knownPlayer = frames.find((h) => PLAYER_HOSTS.some((k) => h === k || h.endsWith(`.${k}`)));
  const signals = [];
  if (/<video\b/i.test(page.html)) signals.push('video');
  if (knownPlayer) signals.push(`frame:${knownPlayer}`);
  if (EPISODE_OPTION.test(page.html)) signals.push('episode-picker');
  const unknownFrame = frames.find((h) => h && siteOf(h) !== siteOf(new URL(page.url).hostname));
  if (!signals.length && unknownFrame) signals.push(`frame?:${unknownFrame}`);
  return { ...row, verdict: signals.length && !signals[0].startsWith('frame?') ? 'player' : 'no-player', signals };
}

/** One domain, both questions. */
async function check(domain, kind) {
  const home = await fetchPage(`https://${domain}/`);
  const row = { kind, checkedAt: new Date().toISOString() };
  if (home.error) row.status = `error:${home.error}`;
  else if (home.status >= 400) row.status = `http:${home.status}`;
  else if (challengePage(home.html)) row.status = 'challenge';
  else {
    const finalHost = new URL(home.url).hostname.replace(/^www\./, '');
    if (siteOf(finalHost) !== siteOf(domain)) { row.status = 'moved'; row.movedTo = finalHost; }
    else row.status = 'ok';
  }
  // A home page that refuses this script (a wall, a 403 for a fetch without
  // a browser's fingerprint) says nothing about a chapter a person already
  // opened: a hand-written sample is tried whatever the home page said.
  if (row.status !== 'ok' && !samples[domain]?.url) return row;
  if (kind === 'video') return { ...row, ...(await episodeVerdict(domain, home)) };

  const found = await findSample(domain, home);
  if (!found) {
    // Someone looked and wrote why there is no chapter to fetch: a parked
    // domain, a site that moved, a store that needs an account, a network
    // that blocks it from here. That word is the verdict, prefixed so the
    // reader of the table knows it came from a person, not from this script.
    const hand = samples[domain]?.note;
    if (hand) return { ...row, sample: null, verdict: `hand:${hand.split(':')[0].trim()}`, note: hand };
    return { ...row, sample: null, verdict: 'no-sample' };
  }
  const page = await fetchPage(found.url);
  row.sample = found.url;
  row.sampleVia = found.via;
  if (samples[domain]?.note) row.note = samples[domain].note;
  // What the person saw on the rendered page, which a fetch cannot see.
  if (samples[domain]?.seen) row.seen = samples[domain].seen;
  if (page.error || page.status >= 400) return { ...row, verdict: `sample-${page.error ? `error:${page.error}` : `http:${page.status}`}` };
  if (challengePage(page.html)) return { ...row, verdict: 'sample-challenge' };
  const a = analyze(page.html, page.url, { rules });
  return { ...row, verdict: a.verdict, images: a.imageCount, engine: a.engine || null };
}

async function main() {
  // `--candidates`: the sites docs/sites-candidates.json proposes (gathered
  // from the community indexes), checked the same way and written to their
  // own table, so a site is looked at before it is ever added to the rules.
  if (process.argv[2] === '--candidates') return candidates();
  const only = process.argv[2] || '';
  const domains = [
    ...Object.keys(rules.domains || {}).filter((k) => !k.startsWith('_')).map((k) => [k.replace(/^\*\./, ''), 'reading']),
    ...Object.keys(rules.videoDomains || {}).filter((k) => !k.startsWith('_')).map((k) => [k, 'video']),
  ].filter(([d]) => d.includes(only));

  const results = {};
  let i = 0;
  const worker = async () => {
    while (i < domains.length) {
      const [d, kind] = domains[i++];
      results[d] = await check(d, kind);
      process.stdout.write(`${d.padEnd(34)} ${results[d].status}${results[d].verdict ? ` · ${results[d].verdict}` : ''}\n`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const out = join(root, 'docs', 'sites-registry.json');
  // A filtered run updates the rows it checked and keeps the rest.
  let previous = {};
  if (only && existsSync(out)) previous = JSON.parse(readFileSync(out, 'utf8'));
  const registry = { ...previous, ...results };
  writeFileSync(out, JSON.stringify(registry, null, 2) + '\n');
  writeFileSync(join(root, 'docs', 'sites-registry.md'), markdown(registry));

  const counts = {};
  for (const r of Object.values(registry)) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log('\n' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · '));
}

async function candidates() {
  const file = join(root, 'docs', 'sites-candidates.json');
  const wanted = Object.entries(JSON.parse(readFileSync(file, 'utf8'))).filter(([k]) => !k.startsWith('_'));
  const results = {};
  let i = 0;
  const worker = async () => {
    while (i < wanted.length) {
      const [d, meta] = wanted[i++];
      results[d] = { ...meta, ...(await check(d, meta.kind)) };
      process.stdout.write(`${d.padEnd(34)} ${results[d].status}${results[d].verdict ? ` · ${results[d].verdict}` : ''}\n`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  writeFileSync(join(root, 'docs', 'sites-candidates-results.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(root, 'docs', 'sites-candidates.md'), candidatesMarkdown(results));
  const counts = {};
  for (const r of Object.values(results)) counts[r.verdict || r.status] = (counts[r.verdict || r.status] || 0) + 1;
  console.log('\n' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · '));
}

function candidatesMarkdown(results) {
  const date = Object.values(results).map((r) => r.checkedAt).sort().at(-1)?.slice(0, 10) || '';
  const sections = [['anime', 'Anime (la barre vidéo)'], ['manga', 'Manga'], ['novel', 'Light novels'], ['webtoon', 'Webcomics et webtoons']];
  const out = [
    '# Sites candidats',
    '',
    `Généré par \`node scripts/check-sites.mjs --candidates\`. Dernière vérification : **${date}**. Ne pas éditer à la main.`,
    '',
    'Les cinquante sites les plus cités par catégorie dans les index communautaires (fmhy.net, wotaku.wiki), plus les sites français déjà connus, vérifiés comme le registre : la page d\'accueil, puis un chapitre (lecture) ou un épisode (vidéo). Pour un site de lecture, le verdict est celui de `shared/compat.js` sur la page échantillon. Pour un site vidéo, `player` veut dire que la page d\'épisode porte ce sur quoi la barre vidéo se pose (une `<video>`, un lecteur en iframe d\'un hôte connu, un sélecteur d\'épisodes) ; `no-player` qu\'elle a répondu sans rien de tel dans son balisage (un lecteur construit en JavaScript : à ouvrir à la main). `known` : déjà dans `shared/detection-rules.json`.',
    '',
    'Depuis ce PC, `challenge`, `timeout` et `http:403` ne condamnent pas un site : l\'antivirus et le FAI en bloquent une partie, et un téléphone sur un autre réseau les voit.',
    '',
    'La colonne **Navigateur** est ce qu\'une personne a vu en ouvrant le site dans un vrai navigateur (le 20 septembre, depuis ce PC) : `player` : la page d\'épisode porte une `<video>`, un lecteur en iframe ou un sélecteur d\'épisodes ; `ready`, `ready-text`, `likely` : la page rendue montre des scans, ou de la prose ; `paginated` : un scan par adresse, un mode page par page à écrire ; `wall` : un Turnstile Cloudflare ou un mur que l\'on ne contourne pas ; `no-sample` : une application JavaScript dont l\'accueil ne lie aucun épisode ni chapitre ; `down`, `dead`, `blocked` : le site ne répond pas, est parqué, ou ce navigateur a refusé d\'y aller.',
    '',
  ];
  for (const [medium, title] of sections) {
    const rows = Object.entries(results).filter(([, r]) => r.medium === medium).sort(([a], [b]) => a.localeCompare(b));
    const counts = {};
    for (const [, r] of rows) counts[r.verdict || r.status] = (counts[r.verdict || r.status] || 0) + 1;
    out.push(`## ${title}`, '', `${rows.length} sites. ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}.`, '',
      '| Domaine | Connu | Accueil | Script | Navigateur | Ce qui a été vu | Échantillon |', '|---|---|---|---|---|---|---|',
      ...rows.map(([d, r]) => `| ${d} | ${r.known ? 'oui' : ''} | ${r.status}${r.movedTo ? ` → ${r.movedTo}` : ''} | ${r.verdict || ''} | ${r.browser?.verdict || ''} | ${r.browser?.detail || (r.signals ? r.signals.join(', ') : r.images != null ? `${r.images} images` : '')}${r.note ? ` ; ${r.note}` : ''} | ${r.browser?.sample ? `[lien](${r.browser.sample})` : r.sample ? `[lien](${r.sample})` : ''} |`),
      '');
  }
  return out.join('\n');
}

function markdown(registry) {
  const rows = Object.entries(registry).sort(([a], [b]) => a.localeCompare(b));
  const date = rows.map(([, r]) => r.checkedAt).sort().at(-1)?.slice(0, 10) || '';
  const counts = {};
  for (const [, r] of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const verdicts = {};
  for (const [, r] of rows) if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
  return [
    '# Registre des sites',
    '',
    `Généré par \`node scripts/check-sites.mjs\`. Dernière vérification : **${date}**. Ne pas éditer à la main : relancer le script.`,
    '',
    'Chaque domaine de `shared/detection-rules.json` est visité une fois (page d\'accueil), et pour les sites de lecture qui répondent, le premier lien de chapitre trouvé est passé à `shared/compat.js`, l\'analyse que le lecteur lui-même exécute. Une ligne est une preuve datée, pas une promesse.',
    '',
    '**Lire les colonnes.** `ok` : la page d\'accueil répond. `challenge` : un mur anti-robot (Cloudflare) répond à la place de la page ; depuis un téléphone le site marche souvent, depuis ce PC non. `moved` : le domaine redirige vers un autre, l\'entrée est périmée. `error:ENOTFOUND` : le domaine n\'existe plus. `http:4xx/5xx` : le serveur refuse. Le verdict est celui du lecteur sur la page échantillon : `ready`/`likely` veut dire qu\'il s\'ouvrirait ; `no-sample` que ni la page d\'accueil, ni la première page de série qu\'elle lie, ni `docs/sites-samples.json` ne donnent de chapitre à regarder. `hand:…` est un verdict écrit par une personne qui a ouvert le site dans un navigateur (`dead` : domaine parqué ou expiré ; `moved` : le site a changé de domaine ; `blocked` : ce réseau ne le laisse pas charger ; `account` : il faut un compte ; `app` : la lecture se fait dans une application). Un échantillon marqué (main) vient du même fichier.',
    '',
    `Accueil : ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}.`,
    `Verdicts : ${Object.entries(verdicts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}.`,
    '',
    '| Domaine | Type | Accueil | Verdict | Images | Échantillon | Note |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(([d, r]) => `| ${d} | ${r.kind} | ${r.status}${r.movedTo ? ` → ${r.movedTo}` : ''} | ${r.verdict || ''} | ${r.images ?? ''} | ${r.sample ? `[lien](${r.sample})${r.sampleVia === 'hand' ? ' (main)' : ''}` : ''} | ${[r.seen ? `vu : ${r.seen}` : '', r.note].filter(Boolean).join(' ; ')} |`),
    '',
  ].join('\n');
}

main();
