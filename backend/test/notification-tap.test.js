// Tapping a new-chapter banner on the phone opens that chapter (QA P8).
//
// The banner always carried the address (native/src/notify.js, `data.url`)
// and nothing on the phone read it back: a tap opened the app wherever it was.
// followTaps runs here with a stand-in for expo-notifications; the shell's
// wiring is read from its source, the way native-polish.test.js reads the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { followTaps } from '../../native/src/notification-tap.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const CHAPTER = 'https://site.example/manga/ao-no-hako/chapitre-110';
const response = (url) => ({ notification: { request: { content: { data: { url, id: 'n1' } } } } });

/** expo-notifications as far as followTaps uses it, with a hand to tap. */
function fakeApi({ launch = null } = {}) {
  return {
    last: launch,
    listeners: [],
    cleared: 0,
    getLastNotificationResponse() { return this.last; },
    clearLastNotificationResponse() { this.last = null; this.cleared++; },
    addNotificationResponseReceivedListener(fn) {
      this.listeners.push(fn);
      return { remove: () => { this.listeners = this.listeners.filter((f) => f !== fn); } };
    },
    tap(r) { this.last = r; for (const fn of this.listeners) fn(r); },
  };
}

test('a banner tapped while the app runs opens its chapter', () => {
  const api = fakeApi();
  const opened = [];
  const stop = followTaps(api, (u) => opened.push(u));
  api.tap(response(CHAPTER));
  assert.deepEqual(opened, [CHAPTER]);
  stop();
  api.tap(response(`${CHAPTER}-bis`));
  assert.equal(opened.length, 1, 'still following taps after the shell let go');
});

test('the app launched by a tap opens that chapter once, not at every reload', () => {
  const api = fakeApi({ launch: response(CHAPTER) });
  const opened = [];
  followTaps(api, (u) => opened.push(u))();
  assert.deepEqual(opened, [CHAPTER]);
  assert.equal(api.cleared, 1, 'the launch response is left behind for the next reload');
  // A JavaScript reload (an update applied on return to the app) starts the shell again.
  followTaps(api, (u) => opened.push(u))();
  assert.equal(opened.length, 1, 'the same chapter opened again with nobody tapping');
});

test('a banner with no chapter opens nothing, and a module that cannot say breaks nothing', () => {
  const api = fakeApi();
  const opened = [];
  followTaps(api, (u) => opened.push(u));
  api.tap(response(null));
  api.tap(null);
  assert.deepEqual(opened, []);
  assert.doesNotThrow(() => followTaps({}, () => {})(), 'a build without the module');
  assert.doesNotThrow(() => followTaps({
    getLastNotificationResponse() { throw new Error('not available'); },
    addNotificationResponseReceivedListener: () => ({ remove() {} }),
  }, () => {})());
});

test('the shell sends a tapped banner through its one door into the browser', () => {
  const shell = read('native', 'src', 'Shell.js');
  assert.match(shell, /onTap\(openUrl\)/, 'taps do not reach openUrl');
  // openUrl is where anything but http(s) is refused (web-url.js).
  const at = shell.indexOf('const openUrl = useCallback');
  assert.match(shell.slice(at, at + 300), /webUrl\(url\)/);
  assert.match(shell, /key=\{browsing\}/, 'a tap while the browser is open would leave its page as it was');
  const notify = read('native', 'src', 'notify.js');
  assert.match(notify, /export const onTap = \(open\) => followTaps\(Notifications, open\)/);
  // And the banner still carries the address this follows.
  assert.match(notify, /data: \{ url: notification\?\.url/);
});
