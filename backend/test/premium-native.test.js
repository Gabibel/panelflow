// PanelFlow Premium on the phone: what the App Store's answer means, with and
// without a network (native/src/premium-state.js), and the core's two
// messages (getPremium, refreshPremium) that ask the server rather than tell it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootCore, json } from '../test-support/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const state = () => import('../../native/src/premium-state.js');

const DAY = 86400_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const at = (days) => new Date(NOW + days * DAY).toISOString();
const info = (entitlement) => ({ entitlements: { active: entitlement ? { premium: entitlement } : {} } });

test('the App Store\'s answer is kept as a date, and a trial is said to be one', async () => {
  const { fromCustomerInfo } = await state();
  const kept = fromCustomerInfo(info({ isActive: true, expirationDate: at(7), willRenew: true, periodType: 'TRIAL' }), NOW);
  assert.deepEqual(kept, { active: true, until: at(7), willRenew: true, trial: true, checkedAt: new Date(NOW).toISOString() });
  assert.equal(fromCustomerInfo(info(null), NOW).active, false);
  assert.equal(fromCustomerInfo(info({ isActive: true, expirationDate: null }), NOW).until, null, 'a lifetime grant');
  assert.equal(fromCustomerInfo(null, NOW).active, false);
});

test('with no network, Premium holds until its date', async () => {
  const { stillPremium } = await state();
  const kept = { active: true, until: at(5), willRenew: false, checkedAt: at(-20) };
  assert.equal(stillPremium(kept, NOW), true, 'a phone on a plane is still Premium');
  assert.equal(stillPremium(kept, NOW + 6 * DAY), false, 'a subscription that was not renewing ends on its date');
});

test('a renewing subscription is believed a few days past its date, until someone can ask', async () => {
  const { stillPremium, GRACE_MS } = await state();
  const kept = { active: true, until: at(0), willRenew: true, checkedAt: at(-3) };
  assert.equal(stillPremium(kept, NOW + DAY), true, 'renewed on a day with no network');
  assert.equal(stillPremium(kept, NOW + GRACE_MS + 1), false, 'not forever');
  // Asked after the date, and the answer still said that date: it did not renew.
  assert.equal(stillPremium({ ...kept, checkedAt: at(0.5) }, NOW + DAY), false);
});

test('nothing kept, or nonsense kept, is not Premium', async () => {
  const { stillPremium } = await state();
  for (const kept of [null, {}, { active: true, until: 'soon' }, { active: 'yes', until: at(30) }]) {
    assert.equal(stillPremium(kept, NOW), false, JSON.stringify(kept));
  }
  assert.equal(stillPremium({ active: true, until: null }, NOW), true, 'a lifetime grant');
});

test('the phone\'s purchase or the account\'s: either one is enough', async () => {
  const { combine } = await state();
  const device = { active: true, until: at(30), willRenew: true, checkedAt: at(0) };
  assert.equal(combine(device, null, NOW).source, 'device', 'bought before any account existed');
  const account = { active: true, until: at(300) };
  const both = combine(device, account, NOW);
  assert.equal(both.active, true);
  assert.equal(both.until, at(300), 'the later end is the one shown');
  assert.equal(combine(null, account, NOW).source, 'account', 'bought on another iPhone');
  assert.deepEqual(combine(null, { active: false }, NOW).active, false);
});

test('prices are the App Store\'s, and the trial is offered only to who can have it', async () => {
  const { plansFrom, ELIGIBLE } = await state();
  const pkg = (id, price) => ({
    identifier: `$rc_${id}`,
    product: {
      identifier: `panelflow_premium_${id}`, priceString: price,
      introPrice: { price: 0, periodNumberOfUnits: 1, periodUnit: 'WEEK' },
    },
  });
  const offerings = { current: { monthly: pkg('monthly', '1,99 €'), annual: pkg('yearly', '14,99 €') } };
  const eligible = { panelflow_premium_monthly: { status: ELIGIBLE }, panelflow_premium_yearly: { status: ELIGIBLE } };
  const plans = plansFrom(offerings, eligible);
  assert.deepEqual(plans.monthly, { id: '$rc_monthly', product: 'panelflow_premium_monthly', period: 'month', price: '1,99 €', trialDays: 7 });
  assert.equal(plans.annual.price, '14,99 €');
  assert.equal(plansFrom(offerings, {}).monthly.trialDays, 0, 'an Apple ID that had its trial is not promised one');
  assert.equal(plansFrom({ current: null }), null, 'nothing configured, nothing on sale');
  // No price is written in the app: what is on screen comes from the store.
  for (const file of ['native/src/screens/settings/PremiumPage.js', 'native/src/premium.js']) {
    assert.ok(!/\d+[,.]\d\d\s*(€|\$)|(€|\$)\s*\d/.test(read(file)), `${file} writes a price`);
  }
});

test('signed out, the core says "not here" without asking the server', async () => {
  const asked = [];
  const { hub } = bootCore({ fetch: async (url) => { asked.push(String(url)); return json({}); } });
  const r = await hub({ type: 'getPremium' });
  assert.equal(r.premium.active, false);
  assert.equal(r.premium.account, false);
  const again = await hub({ type: 'refreshPremium' });
  assert.equal(again.premium.active, false);
  assert.deepEqual(asked.filter((u) => u.includes('/api/premium')), []);
});

test('signed in, the core asks the server to look, and sends nothing about a purchase', async () => {
  const asked = [];
  const { hub } = bootCore({
    storage: { authToken: 'tok', authUser: { id: 'u', email: 'r@example.test' }, dataOwner: 'u' },
    fetch: async (url, init = {}) => {
      asked.push({ url: String(url), method: init.method || 'GET', body: init.body });
      return json({ available: true, active: true, until: '2027-01-01T00:00:00.000Z' });
    },
  });
  const r = await hub({ type: 'refreshPremium', active: true });
  assert.equal(r.premium.active, true);
  const call = asked.find((c) => c.url.endsWith('/api/premium/refresh'));
  assert.equal(call.method, 'POST');
  assert.equal(call.body, undefined, 'the phone never says it paid');
  const g = await hub({ type: 'getPremium' });
  assert.equal(g.premium.account, true);
});

test('a page in the in-app browser cannot ask about Premium', () => {
  // PAGE_TYPES is the door a site's page goes through; Premium is not behind it.
  const core = read('native', 'src', 'core.js');
  const types = core.slice(core.indexOf('PAGE_TYPES'), core.indexOf(']', core.indexOf('PAGE_TYPES')));
  assert.ok(!/Premium/.test(types));
});

test('the SDK is touched in one file, and the purchase follows the account', () => {
  const files = ['native/src/Shell.js', 'native/src/screens/settings/PremiumPage.js',
    'native/src/screens/AccountScreen.js', 'native/src/premium-state.js'];
  for (const f of files) assert.ok(!/react-native-purchases/.test(read(f)), `${f} imports the SDK`);
  assert.match(read('native/src/premium.js'), /from 'react-native-purchases'/);
  assert.match(read('native/src/Shell.js'), /identify\(accountId\)/);
  // A new native module: the version moves, so no update over the air can
  // bring this code to a build that does not have it.
  assert.notEqual(JSON.parse(read('native/app.json')).expo.version, '0.1.1');
});
