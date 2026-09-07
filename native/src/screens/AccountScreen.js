// The account, and the two settings this shell has of its own.
//
// Signing in is the whole of what makes a phone worth having beside a browser:
// the library and the bookmarks are the account's, so the same series is on the
// same chapter here as it was on the desktop an hour ago. Everything below goes
// through the same `auth` / `syncNow` / `checkNow` messages the extension's
// options page sends, which is why signing in on either one settles both.
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { send } from '../core.js';
import { t, LANGS, setLang, currentLang } from '../i18n.js';
import { Button, Field, Heading, Hint } from '../ui.js';

export default function AccountScreen({ store, colors, toast }) {
  const { account, settings } = store;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [apiUrl, setApiUrl] = useState('');

  useEffect(() => { setApiUrl(settings.backendUrl || ''); }, [settings.backendUrl]);

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

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {account ? (
        <View>
          {/* The sentence ends where the address begins — it carries no
              placeholder, because every other surface prints the address in
              bold after it rather than inside it. */}
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
        </View>
      ) : (
        <View>
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
        </View>
      )}

      <Heading colors={colors}>{t('fieldLanguage')}</Heading>
      <View style={styles.row}>
        {[{ code: 'auto', label: t('optionsLanguageAuto') }, ...LANGS].map((l) => {
          const on = (l.code === 'auto' ? !LANGS.some((x) => x.code === currentLang()) : l.code === currentLang());
          return (
            <Pressable
              key={l.code}
              onPress={async () => {
                setLang(l.code);
                // Stored on the account, not on the device: choosing French on
                // the phone has to reach the desktop, which is the whole point
                // of `uiLang` being a preference rather than a local setting.
                await send({ type: 'setAccountPrefs', patch: { uiLang: l.code } });
                await store.refresh();
              }}
              style={[styles.chip, {
                borderColor: on ? colors.accent : colors.line,
                backgroundColor: on ? colors.surfaceHi : 'transparent',
              }]}
            >
              <Text style={{ color: on ? colors.text : colors.muted }}>{l.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Heading colors={colors}>{t('optionsApiUrl')}</Heading>
      <Field
        colors={colors}
        label={t('optionsApiUrl')}
        value={apiUrl}
        onChangeText={setApiUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://panelflow-backend.vercel.app"
      />
      <Button
        colors={colors}
        kind="ghost"
        busy={busy === 'save'}
        label={t('actionSave')}
        onPress={() => run('save', async () => {
          // A cleared box means "back to the default", and the core is what
          // decides what the default is — so the blank is sent as a blank.
          await send({ type: 'setSettings', patch: { backendUrl: apiUrl.trim() } });
          await store.refresh();
          toast(t('statusSaved'));
        })}
      />
      <Hint colors={colors}>
        {/* The options page says this with a <code> in it; a phone has no
            markup to put one in, so the tag is dropped and the sentence is not. */}
        {t('optionsBackendHint').replace(/<[^>]+>/g, '')}
      </Hint>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  who: { fontSize: 16, marginBottom: 12 },
  email: { fontWeight: '600' },
  error: { fontSize: 13, marginVertical: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
});
