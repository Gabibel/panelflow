// Ce qu'une panne dit d'elle-même.
//
// PanelFlow est un cœur partagé derrière quatre façades : une action traverse
// une interface, un hub, le cœur, une requête HTTP, une route et la base. À
// chaque étage un `catch` la réduisait à une phrase écrite pour le lecteur —
// « connecte à nouveau ce tracker » — ce qui est le bon message à afficher, et
// tout ce qui restait. Retrouver la cause voulait dire relire tous les handlers
// capables de produire cette phrase-là.
//
// La phrase n'a pas bougé : les clients l'affichent, elle est vérifiée ici
// aussi. Ce qui est neuf voyage à côté d'elle, et c'est ce que ce fichier
// protège — parce qu'une trace n'est utile que si personne ne l'a coupée depuis,
// et qu'une trace coupée ne fait échouer aucun autre test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootCore, json } from '../test-support/core.js';
import { bootWorker } from '../test-support/worker.js';
import { diag } from '../src/panelflow-core.js';
import { base, shutdown } from '../test-support/harness.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

test.after(shutdown);

test('une requête refusée dit laquelle, et ce qu’elle a répondu', async () => {
  const { core } = bootCore({
    storage: { authToken: 't' },
    fetch: async () => json({ error: 'connect that tracker again' }, 502),
  });

  const err = await core.apiFetch('/api/trackers/anilist/pull', { method: 'POST' })
    .then(() => null, (e) => e);

  assert.ok(err, 'un 502 doit lever');
  // La phrase du serveur, intacte : c'est elle qui finit à l'écran.
  assert.equal(err.message, 'connect that tracker again');
  assert.equal(err.pfOrigin, 'apiFetch');
  assert.equal(err.pfPath, '/api/trackers/anilist/pull');
  assert.equal(err.pfMethod, 'POST');
  assert.equal(err.pfStatus, 502);
});

test('un réseau absent nomme quand même la requête', async () => {
  // Sans fetch, bootCore lève « offline » — ce que dit un téléphone dans le
  // métro, et qui ne disait pas vers quel backend il n'arrivait pas à sortir.
  const { core } = bootCore({ storage: { authToken: 't' } });

  const err = await core.apiFetch('/api/library').then(() => null, (e) => e);

  assert.ok(err);
  assert.equal(err.pfOrigin, 'apiFetch');
  assert.equal(err.pfPath, '/api/library');
  assert.equal(err.pfStatus, undefined, 'rien n’a répondu, donc pas de statut');
});

test('le hub nomme le message qui est mort, sans toucher à la phrase', async () => {
  const { hub } = bootCore({
    storage: { authToken: 't' },
    fetch: async () => json({ error: 'la recherche est indisponible' }, 502),
  });

  const reply = await hub({ type: 'search', q: 'blue box' });

  assert.equal(reply.error, 'la recherche est indisponible');
  assert.equal(reply.failedAt, 'hub:search',
    'sans ça, la phrase à l’écran ne désigne aucun des messages du hub');
});

test('la référence du serveur traverse le hub jusqu’au client', async () => {
  // Un 500 non étiqueté ne peut rien dire d'utile au lecteur — c'est voulu, il
  // part chez un inconnu. Il porte une référence, et elle doit survivre aux
  // deux `catch` qui la séparent de la personne à qui on demandera de la lire.
  const { hub } = bootCore({
    storage: { authToken: 't' },
    fetch: async () => json({ error: 'internal error', ref: 'k3f9az' }, 500),
  });

  const reply = await hub({ type: 'search', q: 'x' });

  assert.equal(reply.failedAt, 'hub:search');
  assert.equal(reply.ref, 'k3f9az');
});

test('aucun message du hub ne laisse échapper son rejet', async () => {
  // `return core.x()` dans un `try` d'une fonction async n'est **pas** attrapé
  // par le `catch` : la promesse est adoptée après coup. Huit cas s'écrivaient
  // comme ça, et le symptôme n'était pas une phrase mal choisie — c'était
  // `sendResponse` jamais appelé, le port qui se ferme, et « The message port
  // closed before a response was received » côté appelant. Une recherche qui
  // répond 502 devenait une erreur de Chrome.
  //
  // Le test ne relit pas la liste : il envoie tous les messages du hub avec un
  // réseau qui refuse, et vérifie qu'aucun ne rejette. Un `await` oublié dans un
  // cas ajouté plus tard tombe ici sans que personne ait à y penser.
  const src = read('shared', 'panelflow-core.js');
  const from = src.indexOf('function createHub(');
  const types = [...new Set(
    src.slice(from).match(/case '([a-zA-Z]+)':/g).map((m) => m.slice(6, -2)),
  )];
  assert.ok(types.length > 40, `le hub ne répond plus qu’à ${types.length} messages`);

  const { hub } = bootCore({
    storage: { authToken: 't' },
    fetch: async () => json({ error: 'nope' }, 502),
  });

  const escaped = [];
  for (const type of types) {
    // Des arguments plausibles pour tous : ce qui est testé est le chemin
    // d'échec, pas la validation, et un message mal formé échoue tout autant.
    await hub({ type, url: 'https://scan.test/c/1', sourceUrl: 'https://scan.test/s', q: 'x' })
      .catch((e) => escaped.push(`${type}: ${e && e.message}`));
  }

  assert.deepEqual(escaped, [],
    'un rejet qui sort du hub ferme le port sans réponse, et rien ne dit lequel');
});

test('la frame la plus interne garde la main sur l’origine', async () => {
  // Une frame plus haute qui re-étiquette écrase l'endpoint qui a réellement
  // cassé, et l'étiquette devient un mensonge exact — le pire genre.
  const err = diag.tag(new Error('boom'), 'apiFetch', { pfPath: '/api/library' });
  diag.tag(err, 'syncAll', { pfPath: '/ailleurs' });

  assert.equal(err.pfOrigin, 'apiFetch');
  assert.equal(err.pfPath, '/api/library');
});

test('les dernières pannes sont gardées, parce que la console était fermée', async () => {
  // Un service worker MV3 s'endort et une WebView hors-écran n'a pas de console
  // du tout : au moment où quelqu'un pense à regarder, il n'y a plus rien.
  const { hub } = bootCore({ storage: { authToken: 't' } });

  await hub({ type: 'compat', url: 'https://scan.test/x' });
  const trail = diag.trail();
  const last = trail[trail.length - 1];

  assert.ok(last, 'une panne doit laisser une trace');
  assert.equal(last.scope, 'hub:compat');
  assert.equal(last.origin, 'apiFetch', 'la trace nomme l’étage, pas seulement le message');
  assert.ok(last.at, 'sans horodatage, deux pannes ne se distinguent pas');
  assert.ok(trail.length <= 40, 'l’anneau est borné, il vit dans un worker');
});

test('un 500 du serveur porte une référence, et le log porte la même', async () => {
  // La route n'existe pas : Express répond 404, pas 500. Ce qu'on vérifie ici
  // est la forme du 500 lui-même, sur le middleware tel qu'il est livré.
  const src = read('backend', 'src', 'index.js');
  const from = src.indexOf('app.use((err, req, res, _next) => {');
  assert.ok(from !== -1, 'le middleware d’erreur n’est plus là où ce test le cherche');
  const middleware = src.slice(from, src.indexOf('export { app };'));

  assert.match(middleware, /res\.status\(500\)\.json\(\{ error: 'internal error', ref \}\)/,
    'la réponse doit porter la référence, sinon personne ne peut la citer');
  assert.match(middleware, /console\.error\(`\[500 \$\{ref\}\] \$\{req\.method\} \$\{req\.originalUrl\}`/,
    'et le log doit porter la même, avec la route — c’est tout l’intérêt');

  // Un refus délibéré n'a pas de référence et n'en a pas besoin : son message
  // est la cause. Vérifié sur un vrai appel, pas sur du texte.
  const refused = await fetch(`${base}/api/library`);
  assert.equal(refused.status, 401);
  const body = await refused.json();
  assert.ok(body.error, 'un refus dit ce qui ne va pas');
  assert.equal(body.ref, undefined, 'et n’a rien à faire chercher dans un log');
});

test('le site web attache la requête à l’erreur qu’il montre', async () => {
  // web/app.js est un script de page sans exports : la règle est extraite du
  // fichier livré, jamais réécrite ici (§0.4 de la feuille de route).
  const src = read('web', 'app.js');
  const from = src.indexOf('async function unwrap(res, path) {');
  const to = src.indexOf('// Two different questions about one column');
  assert.ok(from !== -1 && to > from, 'unwrap n’est plus là où ce test le cherche');

  const make = new Function('t', 'user', 'signOut', `
    ${src.slice(from, to)}
    return unwrap;`);
  const unwrap = make((k, a) => `${k}:${a}`, null, () => {});

  const err = await unwrap(
    { ok: false, status: 500, json: async () => ({ error: 'internal error', ref: 'k3f9az' }) },
    '/library/42/migrate',
  ).then(() => null, (e) => e);

  assert.ok(err);
  assert.equal(err.message, 'internal error');
  assert.equal(err.pfPath, '/library/42/migrate');
  assert.equal(err.pfStatus, 500);
  assert.equal(err.pfRef, 'k3f9az');
});

test('chaque client lit le failedAt qu’on vient de lui envoyer', async () => {
  // Nommer la panne dans le hub ne sert à rien si personne ne la lit à
  // l'arrivée. Quatre surfaces, quatre points de passage — vérifiés dans le
  // fichier livré, parce qu'aucun d'eux n'est importable depuis node.
  const readers = [
    ['extension', 'send.js'],
    ['extension', 'content', 'reader.js'],
    ['extension', 'content', 'library-modal.js'],
    ['mobile', 'www', 'bridge.js'],
  ];
  for (const path of readers) {
    const src = read(...path);
    assert.match(src, /failedAt/, `${path.join('/')} ne lit plus failedAt`);
    assert.match(src, /\[panelflow\]/, `${path.join('/')} n’écrit plus de ligne nommée`);
  }
});

test('un rejet que personne n’attend a un filet dans chaque contexte long', async () => {
  // Une quarantaine de handlers `async` sont branchés directement sur un
  // bouton. Si le corps lève, la promesse est rejetée sans témoin : le clic ne
  // fait rien, aucun `catch` ne tourne, la console reste vide. Les emballer un
  // par un est une bataille perdue à la ligne suivante ; un écouteur par
  // contexte les nomme tous, et ce test est ce qui empêche d'en perdre un.
  const nets = [
    ['extension', 'background.js'],
    ['extension', 'send.js'],
    ['web', 'app.js'],
    ['mobile', 'www', 'app.js'],
  ];
  for (const path of nets) {
    assert.match(read(...path), /addEventListener\('unhandledrejection'/,
      `${path.join('/')} n’a plus de filet sous ses handlers async`);
  }

  // Celui du worker est vérifié en le déclenchant, pas en relisant sa source :
  // il doit passer par le cœur et non par un console.warn nu, parce que c'est
  // ce qui le fait atterrir dans le `trail` — le seul endroit encore lisible
  // une fois que le worker s'est rendormi.
  const w = bootWorker();
  w.raise(new Error('une alarme qui a levé'));
  // Lu sur le cœur du worker, pas sur celui de ce processus : le sandbox charge
  // sa propre copie du fichier, donc les deux `trail` sont distincts.
  const last = w.core().diag.trail().at(-1);
  assert.equal(last.scope, 'worker:unhandled');
  assert.equal(last.message, 'une alarme qui a levé');
});

test('les coques natives ne perdent plus une enveloppe en silence', async () => {
  // Ni Xcode ni le SDK Android sur ce poste : ces deux fichiers ne compilent
  // nulle part dans cette suite, et rien d'autre ne les regarde. C'est aussi la
  // couche la plus muette du projet — elle n'avait pas une ligne de journal.
  //
  // Trois `return` de chaque côté jettent une enveloppe : un JSON illisible,
  // une enveloppe sans `msg`, une réponse dont l'id n'attend plus personne. En
  // face, `mobile/www/bridge.js` tient une promesse avec un minuteur de 45 s —
  // donc une perte silencieuse ressort trois quarts de minute plus tard en
  // « getLibrary timed out », qui accuse le worker de ce que le natif a fait.
  //
  // Le test est symétrique exprès : les deux coques sont des jumelles, et une
  // seule des deux corrigée est le vrai risque ici.
  const kotlin = read('android', 'app', 'src', 'main', 'java', 'dev', 'panelflow', 'WorkerHost.kt');
  const swift = read('ios', 'Sources', 'WorkerHost.swift');

  assert.match(kotlin, /import android\.util\.Log/, 'Log.w sans son import ne compile pas');
  assert.match(kotlin, /private const val TAG = "panelflow"/,
    'un tag qui n’est pas "panelflow" casse `adb logcat -s panelflow`');
  assert.match(swift, /^import Foundation$/m, 'NSLog vient de Foundation');

  for (const [name, src, log] of [['WorkerHost.kt', kotlin, /Log\.w\(TAG,/g],
                                  ['WorkerHost.swift', swift, /NSLog\("\[panelflow\]/g]]) {
    assert.equal((src.match(log) || []).length, 3,
      `${name} doit nommer ses trois enveloppes perdues, pas deux`);
    assert.match(src, /dropped an envelope that is not/, `${name}: le JSON illisible`);
    assert.match(src, /dropped an envelope with no reply, event or msg/, `${name}: l’enveloppe vide`);
    assert.match(src, /matches nothing in flight/, `${name}: la réponse orpheline`);
  }

  // Deux portes en *amont* de `post()` — donc en amont de la journalisation
  // ci-dessus, qui aurait eu un angle mort exactement là où la première panne
  // se produit. `Bridge.swift` refuse un message avant qu'il atteigne le
  // switchboard ; `ShellViewController` renonce à charger l'app elle-même.
  assert.match(read('ios', 'Sources', 'Bridge.swift'),
    /NSLog\("\[panelflow\] a script message arrived/,
    'un message refusé au portail ne serait nommé nulle part');
  assert.match(read('ios', 'Sources', 'ShellViewController.swift'),
    /www\/index\.html is missing from the bundle/,
    'un écran vide au démarrage est la panne la plus chère à diagnostiquer');
  for (const f of ['Bridge.swift', 'ShellViewController.swift', 'ChapterCheck.swift',
                   'ContentBlocker.swift']) {
    assert.match(read('ios', 'Sources', f), /^import Foundation$/m,
      `${f}: NSLog vient de Foundation`);
  }
});

test('une liste de blocage absente n’est pas une liste qui ne bloque rien', async () => {
  // La règle est écrite noir sur blanc dans ARCHITECTURE.md, pour Chrome. Les
  // deux téléphones en étaient dispensés en silence : Safari répondait
  // `completion(nil)` — c'est-à-dire *succès* — quand `blocker-rules.json`
  // manquait du bundle, et Android renvoyait `emptySet()`. Dans les deux cas le
  // lecteur naviguait sans aucun blocage et toute la pile au-dessus était
  // informée que ça marchait.
  //
  // Aucun des deux ne peut bloquer quoi que ce soit sans le fichier — il n'y a
  // pas de repli embarqué de ce côté-là. Ce qui change est qu'ils ne prétendent
  // plus le contraire.
  assert.match(read('docs', 'ARCHITECTURE.md'),
    /An empty list must never be mistaken for a list that blocks nothing/,
    'la règle que ce test fait respecter a disparu de la doc');

  const swift = read('ios', 'Sources', 'ContentBlocker.swift');
  assert.match(swift, /struct MissingRules: Error/,
    'sans un type d’erreur distinct, « pas de liste » et « liste compilée » restent la même réponse');
  assert.match(swift, /completion\(MissingRules\(\)\)/);
  assert.doesNotMatch(swift, /let json = try\? String\(contentsOf: url\) else \{\s*completion\(nil\)/,
    'le retour en succès sur fichier absent est revenu');

  const kotlin = read('android', 'app', 'src', 'main', 'java', 'dev', 'panelflow', 'AdBlockList.kt');
  assert.match(kotlin, /import android\.util\.Log/, 'Log.w sans son import ne compile pas');
  assert.match(kotlin, /nothing is being blocked/,
    'l’ensemble vide doit dire qu’il est vide');
});

test('les deux clients à hub passent bien par le cœur pour le dire', async () => {
  // Le worker mobile a son propre `catch` autour de l'enveloppe — le hub, lui,
  // répond déjà à ses propres pannes. Celui-là attrape le cas où l'enveloppe
  // elle-même casse, et il doit se nommer plutôt que de rendre une chaîne nue.
  const worker = read('mobile', 'www', 'worker.js');
  assert.match(worker, /diag\.report\('worker:handle', e\)/,
    'le worker mobile a cessé de nommer ses propres pannes');
  assert.match(worker, /failedAt: seen\.scope/);

  // Et le cœur doit continuer à exposer diag : les façades ESM du backend sont
  // écrites à la main (§0.2), donc un export ajouté d'un côté seulement ne
  // casse rien avant le jour où on en a besoin.
  assert.equal(typeof diag.tag, 'function');
  assert.equal(typeof diag.report, 'function');
  assert.equal(typeof diag.trail, 'function');
});
