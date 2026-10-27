// PanelFlow Premium: what it adds, what it costs, and the way out.
//
// What the App Store asks of a page that sells a subscription (guideline
// 3.1.2), all of it on screen before the button: the name of what is sold,
// how long each period lasts, the price per period as the App Store wrote it
// for this phone, the free trial only when this Apple ID can still have it,
// that it renews on its own until cancelled, where to cancel it, a way to
// restore a purchase, and links to the terms and the privacy policy.
//
// What Premium adds is PanelFlow's own work, never access to a site's
// chapters (owner, October 2026): more room for offline reading, and the
// detailed statistics. Reading, saving chapters for offline and today's
// statistics stay free.
//
// The buying is in ../../premium.js; this page only draws its answers.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Text from '../../components/Text.js';
import { currentLang, t } from '../../i18n.js';
import { Button, Heading, Hint } from '../../ui.js';
import {
  buy, manageSubscription, onPremiumChange, premiumPlans, premiumStatus, restore,
} from '../../premium.js';

/** A day the reader can read, in the app's language. */
function dayOf(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() >= 9999) return null;
  return d.toLocaleDateString(currentLang() === 'fr' ? 'fr-FR' : 'en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

export default function PremiumPage({ store, colors, toast, onOpen }) {
  const [status, setStatus] = useState(null);
  const [plans, setPlans] = useState(undefined);
  const [busy, setBusy] = useState(null);
  const base = String(store.settings?.backendUrl || '').replace(/\/+$/, '');

  const load = useCallback(async () => {
    setStatus(await premiumStatus());
    setPlans(await premiumPlans());
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onPremiumChange(() => { premiumStatus().then(setStatus); }), []);

  const act = async (name, work) => {
    setBusy(name);
    try {
      const r = await work();
      if (r?.cancelled) return;
      if (r?.error) toast(t('premiumFailed'));
      else if (name === 'restore') toast(r?.active ? t('premiumRestored') : t('premiumNothingToRestore'));
      else if (r?.active) toast(t('premiumWelcome'));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const links = (
    <View style={styles.links}>
      <Pressable accessibilityRole="link" onPress={() => onOpen(`${base}/${t('legalTermsPage')}`)} hitSlop={8}>
        <Text style={[styles.link, { color: colors.accent }]}>{t('webTerms')}</Text>
      </Pressable>
      <Pressable accessibilityRole="link" onPress={() => onOpen(`${base}/${t('legalPrivacyPage')}`)} hitSlop={8}>
        <Text style={[styles.link, { color: colors.accent }]}>{t('webPrivacy')}</Text>
      </Pressable>
    </View>
  );

  const perks = (
    <View style={styles.perks}>
      {/* Each named in full, so the locale check finds them. */}
      {[t('premiumPerkSpace'), t('premiumPerkStats'), t('premiumPerkFree')].map((line) => (
        <Text key={line} style={[styles.perk, { color: colors.text }]}>{`•  ${line}`}</Text>
      ))}
    </View>
  );

  if (!status) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Hint colors={colors}>{t('trackerAsking')}</Hint>
      </ScrollView>
    );
  }

  if (status.active) {
    const day = status.until ? dayOf(status.until) : null;
    let when = null;
    if (day) when = status.willRenew ? t('premiumRenewsOn', [day]) : t('premiumEndsOn', [day]);
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Heading colors={colors}>{t('premiumActive')}</Heading>
        {!!when && <Hint colors={colors}>{when}</Hint>}
        {status.source === 'account' && <Hint colors={colors}>{t('premiumFromAccount')}</Hint>}
        {perks}
        {status.source === 'device' && (
          <Button colors={colors} kind="ghost" label={t('premiumManage')} onPress={manageSubscription} />
        )}
        {links}
      </ScrollView>
    );
  }

  if (!status.offered) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Heading colors={colors}>{t('premiumTitle')}</Heading>
        {perks}
        <Hint colors={colors}>{t('premiumNotOffered')}</Hint>
      </ScrollView>
    );
  }

  const offer = (plan) => {
    if (!plan) return null;
    const per = plan.period === 'year' ? t('premiumPerYear', [plan.price]) : t('premiumPerMonth', [plan.price]);
    const label = plan.trialDays
      ? t('premiumTrialThen', [String(plan.trialDays), per])
      : per;
    return (
      <Button
        key={plan.period}
        colors={colors}
        kind={plan.period === 'year' ? 'solid' : 'ghost'}
        label={label}
        busy={busy === plan.period}
        disabled={!!busy && busy !== plan.period}
        onPress={() => act(plan.period, () => buy(plan.period))}
      />
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Heading colors={colors}>{t('premiumTitle')}</Heading>
      <Hint colors={colors}>{t('premiumLede')}</Hint>
      {perks}
      {plans === undefined && <Hint colors={colors}>{t('trackerAsking')}</Hint>}
      {plans === null && <Hint colors={colors}>{t('premiumNoPlans')}</Hint>}
      {plans && (
        <View style={styles.plans}>
          {offer(plans.annual)}
          {offer(plans.monthly)}
        </View>
      )}
      <Hint colors={colors}>{t('premiumRenewal')}</Hint>
      <Button
        colors={colors}
        kind="ghost"
        label={t('premiumRestore')}
        busy={busy === 'restore'}
        disabled={!!busy && busy !== 'restore'}
        onPress={() => act('restore', restore)}
      />
      {links}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40, gap: 12 },
  perks: { gap: 8, paddingVertical: 4 },
  perk: { fontSize: 16, lineHeight: 22 },
  plans: { gap: 10 },
  links: { flexDirection: 'row', gap: 20, paddingTop: 8 },
  link: { fontSize: 15, textDecorationLine: 'underline' },
});
