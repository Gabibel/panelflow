// L'étoile, dans l'extension.
//
// Le site a ce contrôle depuis que la vue Sites existe, le téléphone l'a, et
// l'extension ne savait que *lire* la réponse : elle ordonnait sa liste par
// favoris sans offrir aucun moyen d'en marquer un. Le tour d'accueil demandait
// une fois, et c'était le dernier mot de ce client sur la question.
//
// La phrase du site le promettait pourtant, mot pour mot : « Star the ones you
// use and they come first here *and in the extension*. » — vérifié ci-dessous,
// parce que c'est cette promesse qui rendait le manque visible.
//
// Le comportement est extrait du popup livré, jamais réécrit ici (§0.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const src = read('extension', 'popup', 'popup.js');

test('la promesse du site nomme bien l’extension', () => {
  const en = JSON.parse(read('shared', '_locales', 'en', 'messages.json'));
  const sentence = Object.values(en).map((v) => v.message || '').join(' ');
  assert.match(sentence, /come first here and in the extension/,
    'la phrase qui rendait ce manque visible a changé — vérifier que la promesse tient toujours');
});

test('le popup sait marquer un favori, pas seulement le lire', () => {
  assert.match(src, /async function toggleSiteFavourite\(host\)/,
    'l’extension ne pouvait que lire favouriteSites');
  assert.match(src, /setAccountPrefs['"]?,\s*patch:\s*\{\s*favouriteSites/,
    'le favori doit partir sur le compte, pas rester dans ce navigateur');
});

test('elle emprunte les phrases du site plutôt que d’en inventer', () => {
  // Deux formulations pour une action, c'est ainsi que deux surfaces cessent
  // de ressembler au même produit.
  assert.match(src, /webSitesUnpin['"]?\s*:\s*['"]webSitesPin/,
    'le popup doit réutiliser les clés que la vue Sites du web utilise déjà');
  const web = read('web', 'app.js');
  for (const key of ['webSitesPin', 'webSitesUnpin']) {
    assert.ok(web.includes(key), `${key} a disparu du site — les deux surfaces ont divergé`);
  }
});

test('pas d’étoile sans compte pour la retenir', () => {
  // Déconnecté il n'y a nulle part où mettre la réponse, et une étoile qui
  // oublie est pire que pas d'étoile — la règle que le site s'applique déjà.
  assert.match(src, /if \(accountEmail\) \{/,
    'l’étoile doit être conditionnée à un compte');
});

test('dé-marquer un site réglé le rend à « réglé », pas au néant', () => {
  // Le rang d'un hôte est écrasé par « favori » ; sans mémoire de ce qu'il
  // était, l'enlever des favoris le ferait tomber de la liste ou le
  // rétrograderait en « dans la bibliothèque » alors qu'une règle existe.
  assert.match(src, /siteKindBefore = new Map\(known\)/,
    'le rang d’origine doit être conservé pour le retour');
  assert.match(src, /siteKindBefore\.get\(host\) \|\| 'library'/);
  // Gardé *à côté* de la liste et non dedans : `sites` est une forme qu'un
  // test décrit (welcome.test.js), et un détail d'implémentation caché dans
  // ses lignes est un détail que tout le reste doit connaître.
  assert.doesNotMatch(src, /\{ host, kind, was/,
    'le bookkeeping ne doit pas voyager dans la donnée');
});

test('le clic sur l’étoile n’ouvre pas le site', () => {
  // La ligne entière est cliquable et ouvre un onglet. Marquer un site n'est
  // pas une façon de dire « emmène-moi là-bas ».
  assert.match(src, /star\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\)/);
});

test('l’étoile a un style dans le popup, pas seulement sur le site', () => {
  const css = read('extension', 'popup', 'popup.css');
  assert.match(css, /\.site-star\s*\{/, 'un bouton sans style est un bouton qui ne ressemble à rien');
  assert.match(css, /\.site-star\[aria-pressed="true"\]/,
    'marqué et non marqué doivent se distinguer autrement que par le glyphe');
});
