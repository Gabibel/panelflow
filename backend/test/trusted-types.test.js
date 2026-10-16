// The reader opens on a page that enforces Trusted Types.
//
// mangadex.org sends `require-trusted-types-for 'script'`. From then on every
// HTML sink of the page (innerHTML, DOMParser.parseFromString...) refuses a
// plain string. The extension does not feel it: its content scripts run in an
// isolated world the page's policy does not reach. The phone app injects the
// same files into the page's own world, and there the reader's first line of
// markup threw: on the real site the detector found the chapter and the reader
// never opened (QA real-site pass, 2026-10-16, phone).
//
// So each file that writes HTML makes a policy of its own on first use and
// hands its strings through it; clearing an element is done without HTML at
// all. Lifted out of the shipping files, as the other tests here do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const READER = read('extension', 'content', 'reader.js');
const DETECT = read('extension', 'content', 'detect.js');
const MODAL = read('extension', 'content', 'library-modal.js');

/** asHTML from `src`, run against the `trustedTypes` given (or none). */
function liftAsHTML(src, file, trustedTypes) {
  const a = src.indexOf('  let htmlPolicy;');
  const b = src.indexOf('    return htmlPolicy ? htmlPolicy.createHTML(s) : s;\n  };', a);
  assert.ok(a !== -1 && b > a, `${file}: asHTML is not where this test expects it`);
  const code = src.slice(a, b) + '    return htmlPolicy ? htmlPolicy.createHTML(s) : s;\n  };';
  return new Function('globalThis', `${code}\nreturn asHTML;`)({ trustedTypes });
}

/** A page's trustedTypes, keeping count of the policies asked for. */
function enforcing({ refuse = false } = {}) {
  const made = [];
  return {
    made,
    createPolicy(name, rules) {
      if (refuse) throw new TypeError(`Failed to create a TrustedTypePolicy named '${name}'`);
      made.push(name);
      return { createHTML: (s) => ({ trusted: rules.createHTML(s) }) };
    },
  };
}

for (const [file, src, name] of [
  ['reader.js', READER, 'panelflow-reader'],
  ['detect.js', DETECT, 'panelflow-detect'],
]) {
  test(`${file}: on a page that enforces Trusted Types, our HTML goes through a policy of our own, made once`, () => {
    const tt = enforcing();
    const asHTML = liftAsHTML(src, file, tt);
    assert.deepEqual(asHTML('<div class="pf-stage"></div>'), { trusted: '<div class="pf-stage"></div>' });
    assert.deepEqual(asHTML('<p>x</p>'), { trusted: '<p>x</p>' }, 'the string is handed over unchanged');
    assert.deepEqual(tt.made, [name], 'one policy, under our own name, made on first use');
  });

  test(`${file}: a page that refuses our policy, or has no Trusted Types, gets the string as before`, () => {
    assert.equal(liftAsHTML(src, file, enforcing({ refuse: true }))('<b>x</b>'), '<b>x</b>');
    assert.equal(liftAsHTML(src, file, undefined)('<b>x</b>'), '<b>x</b>');
  });
}

test('no HTML sink in the injected files takes a string that has not been through asHTML', () => {
  // Every place these files write or parse HTML, and how it stays legal on a
  // page that enforces Trusted Types. A new sink fails here until it is
  // written through asHTML (or as replaceChildren, to clear).
  const SINK = /\.innerHTML\s*=(?!=)|\.outerHTML\s*=(?!=)|insertAdjacentHTML\(|createContextualFragment\(|parseFromString\(|document\.write\(/;
  for (const [file, src] of [['reader.js', READER], ['detect.js', DETECT], ['library-modal.js', MODAL]]) {
    const lines = src.split('\n').filter((l) => SINK.test(l) && !/^\s*(\/\/|\*)/.test(l));
    for (const line of lines) {
      // The template that builds the reader, and the reader's own drawings
      // (icon(), paths written in the file): nothing from the page in either.
      assert.match(line, /innerHTML = asHTML\(`|innerHTML = asHTML\(icon\(|parseFromString\(asHTML\(/,
        `${file} writes HTML outside asHTML: ${line.trim()}`);
    }
  }
  assert.match(READER, /root\.innerHTML = asHTML\(`/, 'the reader builds its shell through the policy');
  assert.equal((DETECT.match(/parseFromString\(asHTML\(/g) || []).length, 3, 'the three pages the detector parses');
  // And the one page the reader parses: the next chapter's, for its neighbours.
  assert.equal((READER.match(/parseFromString\(asHTML\(/g) || []).length, 1);
});
