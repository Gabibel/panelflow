// Le sélecteur de chapitres lu comme un roman.
//
// Signalé sur Kingdom, chez SushiScan : au lieu du chapitre, le lecteur
// s'ouvrait sur « Kingdom Chapitre 882 / Tous les chapitres sont dans Kingdom /
// SushiScan › Kingdom › … / Sélectionner le chapitre / Chapitre 883 / Chapitre
// 882 / … » — la table des matières de la série, rendue en prose.
//
// Trois choses devaient être vraies en même temps, et elles le sont souvent :
//   1. les panneaux arrivent en différé, donc `.reading-content` est
//      momentanément vide de <img> — et ce sélecteur est dedans ;
//   2. la liste est longue (880 chapitres, ~11 000 caractères) et nombreuse
//      (bien plus que les cinq lignes demandées) ;
//   3. ses entrées sont des <option>, pas des <a> — donc la densité de liens,
//      qui ne comptait que les <a>, valait zéro sur la navigation la plus dense
//      qu'une page puisse porter.
//
// La règle extraite du fichier livré, jamais recopiée ici (§0.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

/** La section « prose chapters » du detect.js livré, avec un faux document. */
function buildNovelContent(elements) {
  const from = src.indexOf('  // --- prose chapters');
  const to = src.indexOf('  function scorePage()');
  assert.ok(from !== -1 && to > from, 'la section prose n’est plus là où ce test la cherche');

  const document = {
    querySelectorAll(sel) {
      if (sel === 'p') return elements.flatMap((e) => e.paragraphs || []);
      return elements.filter((e) => (e.matches || []).includes(sel.split(',')[0].trim()))
        .concat(elements.filter((e) => (e.matches || []).some((m) => sel.includes(m))))
        .filter((e, i, a) => a.indexOf(e) === i);
    },
  };
  const make = new Function('document', 'isVisible', `
    ${src.slice(from, to)}
    return { novelContent, linkDensity, splitLines };`);
  return make(document, (el) => el.visible !== false);
}

/** Le sélecteur de SushiScan : n entrées « Chapitre N », en <option>. */
const picker = (n = 880) => {
  const options = Array.from({ length: n }, (_, i) => ({ innerText: `Chapitre ${882 - i}` }));
  const text = ['Kingdom Chapitre 882', 'Tous les chapitres sont dans Kingdom',
    'SushiScan › Kingdom › Kingdom Chapitre 882', 'Sélectionner le chapitre',
    ...options.map((o) => o.innerText)].join('\n');
  return {
    matches: ['.reading-content'],
    innerText: text,
    visible: true,
    paragraphs: [],
    querySelectorAll: (sel) => (sel.includes('option') ? options : []),
  };
};

test('un sélecteur de chapitres n’est pas un chapitre en prose', () => {
  const { novelContent } = buildNovelContent([picker()]);
  assert.equal(novelContent(), null,
    'le lecteur s’ouvrait sur la table des matières au lieu du chapitre');
});

test('et il ne le devient pas parce qu’il est très long', () => {
  // 880 entrées font ~11 000 caractères : le plancher global de 1200 ne peut
  // rien contre une liste. C'est la longueur *par ligne* qui sépare les deux.
  const { splitLines } = buildNovelContent([picker()]);
  assert.deepEqual(splitLines('Chapitre 883\nChapitre 882\nChapitre 881'), [],
    'une ligne de douze caractères n’est pas un paragraphe');
});

test('la densité de navigation compte les <option>, pas seulement les <a>', () => {
  const { linkDensity } = buildNovelContent([picker()]);
  const el = picker();
  assert.ok(linkDensity(el) > 0.25,
    'un <select> de 880 chapitres notait zéro sur la navigation la plus dense qui soit');
});

test('un vrai chapitre en prose passe toujours', () => {
  // La contrepartie : le correctif ne doit pas coûter les romans, qui sont la
  // raison d'être de tout ce chemin.
  const line = 'Le camp de Qin s’étirait jusqu’à la ligne des collines, et personne '
    + 'ne dormait vraiment cette nuit-là, pas même les chevaux.';
  const body = {
    matches: ['.entry-content'],
    innerText: Array.from({ length: 12 }, () => line).join('\n'),
    visible: true,
    paragraphs: [],
    querySelectorAll: () => [],
  };
  const { novelContent } = buildNovelContent([body]);
  const found = novelContent();
  assert.ok(found, 'un chapitre de roman doit encore être reconnu');
  assert.ok(found.paragraphs.length >= 5);
});
