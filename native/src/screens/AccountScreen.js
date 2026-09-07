// The account, and the four things you can ask the server to do now.
//
// Signing in is the whole of what makes a phone worth having beside a browser:
// the library and the bookmarks are the account's, so the same series is on the
// same chapter here as it was on the desktop an hour ago. Everything below goes
// through the same `auth` / `syncNow` / `checkNow` messages the extension's
// options page sends, which is why signing in on either one settles both.
//
// The settings moved to their own screen. The backend URL is not on either: it
// is the address of the server the account is on, a device that took a wrong
// one would send its library there, and nobody sets it from a phone. It stays
// where it was always meant to be set — `shared/panelflow-core.js`'s default,
// or the options page for someone running a server of their own.
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { send } from '../core.js';
import { setLang, t } from '../i18n.js';
import { Button, Field, Hint } from '../ui.js';

export default function AccountScreen({ store, colors, toast }) {
  const { account } = store;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const run = async (name, work) => {
    setBusy(name);
    try { await work(); } finally { setBusy(null); }
  };

  const submit = (kind) => run(kind, async () => {
    setError(null);
    const r = await send({ type: 'auth', kind, email: email.trim(), password });
    // "No answer at all" is a different problem from "wrong password", and a
    // phone on a train hits the first far more often than the second.
    if (!r) return setError(t('authNoAnswer'));
    if (r.error) return setError(r.error);
    setPassword('');
    // The hub pulls the account's preferences as part of signing in and hands
    // them back with the user, so the language flips here rather than a repaint
    // later.
    setLang(r.prefs?.uiLang ?? 'auto');
    toast(t('statusSignedIn'));
    await store.refresh();
    // Signing in kicks off a pull of its own; give it a moment, then redraw
    // with whatever it brought.
    setTimeout(store.refresh, 2000);
    return undefined;
  });

  if (account) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        {/* The sentence ends where the address begins — it carries no
            placeholder, because every other surface prints the address after
            it rather than inside it. */}
        <Text style={[styles.who, { color: colors.text }]}>
          {t('mobileSignedInAs')}
          <Text style={styles.email}>{account.email}</Text>
        </Text>
        <Button
          colors={colors}
          kind="ghost"
          busy={busy === 'sync'}
          label={t('actionSyncNow')}
          onPress={() => run('sync', async () => {
            await send({ type: 'syncNow' });
            await store.refresh();
            toast(t('statusSynced'));
          })}
        />
        <Button
          colors={colors}
          kind="ghost"
          busy={busy === 'check'}
          label={t('actionCheckNow')}
          onPress={() => run('check', async () => {
            toast(t('statusChecking'));
            await send({ type: 'checkNow' });
            await store.refresh();
          })}
        />
        <Button
          colors={colors}
          kind="ghost"
          busy={busy === 'dedupe'}
          label={t('mobileMergeDuplicates')}
          onPress={() => run('dedupe', async () => {
            const r = await send({ type: 'dedupeLibrary' });
            await store.refresh();
            toast(r?.removed ? t('mobileMerged', [String(r.removed)]) : t('mobileNoDuplicates'));
          })}
        />
        <Button
          colors={colors}
          kind="danger"
          label={t('actionSignOut')}
          onPress={() => run('out', async () => {
            await send({ type: 'logout' });
            await store.refresh();
          })}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Field
        colors={colors}
        label={t('fieldEmail')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <Field
        colors={colors}
        label={t('fieldPassword')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        textContentType="password"
      />
      {error && <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>}
      <Button colors={colors} busy={busy === 'login'} label={t('actionSignIn')} onPress={() => submit('login')} />
      <Button colors={colors} kind="ghost" busy={busy === 'register'} label={t('actionCreateAccount')} onPress={() => submit('register')} />
      <Hint colors={colors}>{t('mobileAccountHint')}</Hint>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  who: { fontSize: 16, marginBottom: 12 },
  email: { fontWeight: '600' },
  error: { fontSize: 13, marginVertical: 6 },
});
