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
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { send } from '../core.js';
import { explain, setLang, t } from '../i18n.js';
import { Button, Field, Hint } from '../ui.js';

export default function AccountScreen({ store, colors, toast, onOpen }) {
  const { account, library } = store;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  // "I am 15 or older": asked to create an account, not to sign in to one.
  const [adult, setAdult] = useState(false);
  // Whether the "delete my account" confirmation is open.
  const [closing, setClosing] = useState(false);
  // Whether the "change my address" form is open, and what is typed in it.
  const [moving, setMoving] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  // Where the legal pages are: on the server the account is (or will be) on.
  const base = String(store.settings?.backendUrl || '').replace(/\/+$/, '');

  const run = async (name, work) => {
    setBusy(name);
    try { await work(); } finally { setBusy(null); }
  };

  /**
   * What is already on this phone, asked about before signing in (report,
   * arbitrage d): a library made without an account — add it, keep it aside,
   * or erase it — or another account's changes that were never sent, named
   * before they are erased. The answer comes back through `then`.
   */
  const askLocal = (r, then) => {
    if (r.needsChoice === 'ownerless') {
      Alert.alert(t('localOwnerlessQuestion', [String(r.series ?? 0)]), t('localSeparateHint'), [
        { text: t('localMerge'), onPress: () => then('merge') },
        { text: t('localSeparate'), onPress: () => then('separate') },
        { text: t('localErase'), style: 'destructive', onPress: () => then('erase') },
        { text: t('actionCancel'), style: 'cancel' },
      ]);
    } else {
      Alert.alert(t('localOtherOwnerQuestion', [String(r.owner ?? '')]), undefined, [
        { text: t('localEraseContinue'), style: 'destructive', onPress: () => then('erase') },
        { text: t('actionCancel'), style: 'cancel' },
      ]);
    }
  };

  const submit = (kind, local = null) => run(kind, async () => {
    setError(null);
    if (kind === 'register' && !adult) return setError(t('accountAgeRequired'));
    const r = await send({ type: 'auth', kind, email: email.trim(), password, ...(local ? { local } : {}) });
    if (r?.needsChoice) return askLocal(r, (answer) => submit(kind, answer));
    // "No answer at all" is a different problem from "wrong password", and a
    // phone on a train hits the first far more often than the second.
    if (!r) return setError(t('authNoAnswer'));
    if (r.error) return setError(explain(r));
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
        {/* A number to compare with another device. "The sync did not bring
            everything" and "the shelf is not drawing everything" are different
            faults with the same appearance, and this is the one line that tells
            them apart without a debugger. */}
        <Text style={[styles.count, { color: colors.muted }]}>
          {t('mobileLibraryCount', [String(library.length)])}
        </Text>
        <Button
          colors={colors}
          kind="ghost"
          busy={busy === 'sync'}
          label={t('actionSyncNow')}
          onPress={() => run('sync', async () => {
            const r = await send({ type: 'syncNow' });
            await store.refresh();
            // Said as it went. A tick with the server down was the one answer
            // this button must never give.
            if (r?.signedOut) return;
            if (r?.ok) toast(t('statusSynced'));
            else toast(!r || r.offline ? t('syncOffline') : t('syncIncomplete'));
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
        {/* The account, as a file. In a browser an export is a link you click
            and the browser knows where to put it; a phone has no downloads
            folder to click into, so the file is written to this app's cache and
            handed to the share sheet, which is where a phone puts things it is
            giving to something else. */}
        <Button
          colors={colors}
          kind="ghost"
          busy={busy === 'export'}
          label={t('webExport')}
          onPress={() => run('export', async () => {
            const r = await send({ type: 'exportAccount' });
            if (r?.error) return toast(explain(r));
            try {
              const file = new File(Paths.cache, 'panelflow-export.json');
              // Overwritten rather than appended to: the second export of the
              // day is a second copy of everything, not a longer file.
              if (file.exists) file.delete();
              file.create();
              file.write(JSON.stringify(r.data, null, 2));
              await Sharing.shareAsync(file.uri, { mimeType: 'application/json' });
            } catch (e) {
              toast(String(e?.message ?? e));
            }
            return undefined;
          })}
        />
        {/* Changing a password takes a link in an inbox, not a form on a
            phone someone else may be holding. The same route the sign-in
            screen's "forgotten" link uses — one flow, one rate limit. */}
        <Hint colors={colors}>{t('webPasswordHint')}</Hint>
        <Button
          colors={colors}
          kind="ghost"
          busy={busy === 'reset'}
          label={t('webEmailMeALink')}
          onPress={() => run('reset', async () => {
            const r = await send({ type: 'forgotPassword', email: account.email });
            toast(r?.error || r?.message || t('webLinkOnItsWay'));
          })}
        />
        {/* Another address. Two proofs, as the server wants them: the
            password typed here, a link the new inbox opens. Nothing changes
            until that link is spent, so the field can simply be cleared. */}
        <Hint colors={colors}>{t('webChangeEmailHint')}</Hint>
        {!moving ? (
          <Button
            colors={colors}
            kind="ghost"
            label={t('webChangeEmail')}
            onPress={() => { setNewEmail(''); setPassword(''); setError(null); setMoving(true); }}
          />
        ) : (
          <>
            <Field
              colors={colors}
              label={t('webNewEmail')}
              value={newEmail}
              onChangeText={setNewEmail}
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
              autoComplete="current-password"
            />
            {error && <Text style={{ color: colors.danger }}>{error}</Text>}
            <Button
              colors={colors}
              busy={busy === 'email'}
              disabled={!password || !newEmail}
              label={t('webSendTheLink')}
              onPress={() => run('email', async () => {
                setError(null);
                const r = await send({ type: 'changeEmail', email: newEmail.trim(), password });
                if (!r) return setError(t('authNoAnswer'));
                if (r.error) return setError(explain(r));
                setMoving(false);
                setPassword('');
                toast(r.message || t('webLinkOnItsWay'));
                return undefined;
              })}
            />
            <Button
              colors={colors}
              kind="ghost"
              label={t('actionCancel')}
              onPress={() => { setMoving(false); setPassword(''); setError(null); }}
            />
          </>
        )}
        <Button
          colors={colors}
          kind="danger"
          label={t('actionSignOut')}
          onPress={() => run('out', async () => {
            const r = await send({ type: 'logout' });
            await store.refresh();
            if (r && r.synced === false) toast(t('logoutKept'));
          })}
        />

        {/* The right to erasure, and the one thing the App Store insists on
            for any app that lets people create an account: a way to close it,
            from inside the app. The password is asked again — a session is a
            token on a phone, and a phone left on a table must not be enough.
            The hub (`deleteAccount` in shared/panelflow-core.js) deletes on
            the server and then empties the device; there is no account left
            to keep a shelf for. */}
        <Hint colors={colors}>{t('webDeleteAccountHint')}</Hint>
        {!closing ? (
          <Button
            colors={colors}
            kind="danger"
            label={t('webDeleteAccount')}
            onPress={() => { setPassword(''); setError(null); setClosing(true); }}
          />
        ) : (
          <>
            <Field
              colors={colors}
              label={t('fieldPassword')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="current-password"
            />
            {error && <Text style={{ color: colors.danger }}>{error}</Text>}
            <Button
              colors={colors}
              kind="danger"
              busy={busy === 'delete'}
              disabled={!password}
              label={t('webDeleteAccountConfirm')}
              onPress={() => run('delete', async () => {
                setError(null);
                const r = await send({ type: 'deleteAccount', password });
                if (!r) return setError(t('authNoAnswer'));
                if (r.error) return setError(explain(r));
                setClosing(false);
                setPassword('');
                setEmail('');
                // A confirmation, not the button's own label read back.
                toast(t('accountDeleted'));
                await store.refresh();
                return undefined;
              })}
            />
            <Button
              colors={colors}
              kind="ghost"
              label={t('actionCancel')}
              onPress={() => { setClosing(false); setPassword(''); setError(null); }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {/* Why the phone is signed out, when the server decided it: an account
          closed from another device, or a password reset. Without it the
          sign-in form simply came back and the account seemed to vanish. */}
      {store.sessionEnded && (
        <Text style={[styles.ended, { color: colors.text, borderColor: colors.line }]} accessibilityLiveRegion="polite">
          {store.sessionEnded.reason === 'deleted' ? t('sessionDeleted') : t('sessionExpired')}
        </Text>
      )}
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
      {/* Resetting a password takes an e-mail, a link and a form, and the
          website already has all three — the link in the mail lands there
          whatever asked for it. The extension opens the same page for the
          same reason. */}
      <Text
        style={[styles.forgot, { color: colors.accent }]}
        accessibilityRole="link"
        onPress={() => onOpen?.(`${base}/#forgot`)}
      >
        {t('actionForgotPassword')}
      </Text>
      {/* PanelFlow is not for people under 15 (privacy policy §11): asked at
          the button that creates the account. A row the size of a finger,
          announced as the checkbox it is. */}
      <Pressable
        onPress={() => setAdult((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: adult }}
        style={styles.check}
      >
        <View style={[styles.box, { borderColor: adult ? colors.accent : colors.line },
          adult && { backgroundColor: colors.accent }]}
        >
          {adult && <Text style={[styles.tick, { color: colors.onAccent }]}>✓</Text>}
        </View>
        <Text style={[styles.checkText, { color: colors.text }]}>{t('accountAge')}</Text>
      </Pressable>
      <Button colors={colors} kind="ghost" busy={busy === 'register'} label={t('actionCreateAccount')} onPress={() => submit('register')} />
      {/* What creating an account means, where it happens — the same sentence
          the web app shows under its button, in pieces because a phone has no
          <a> inside a sentence. The pages open in the app's browser, from the
          server the account will be on. */}
      <Text style={[styles.consent, { color: colors.muted }]} accessibilityRole="text">
        {t('mobileConsentBefore')}
        <Text
          style={{ color: colors.accent }}
          accessibilityRole="link"
          onPress={() => onOpen?.(`${base}/${t('legalTermsPage')}`)}
        >
          {t('mobileConsentTerms')}
        </Text>
        {t('mobileConsentBetween')}
        <Text
          style={{ color: colors.accent }}
          accessibilityRole="link"
          onPress={() => onOpen?.(`${base}/${t('legalPrivacyPage')}`)}
        >
          {t('mobileConsentPrivacy')}
        </Text>
        {t('mobileConsentAfter')}
      </Text>
      <Hint colors={colors}>{t('accountPitch')}</Hint>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  who: { fontSize: 16, marginBottom: 4 },
  ended: { fontSize: 14, lineHeight: 20, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12 },
  count: { fontSize: 13, marginBottom: 12 },
  email: { fontWeight: '600' },
  error: { fontSize: 13, marginVertical: 6 },
  consent: { fontSize: 12, lineHeight: 18, marginTop: 10, textAlign: 'center' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 6 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { fontSize: 14, fontWeight: '700', lineHeight: 16 },
  checkText: { fontSize: 15, flexShrink: 1 },
  forgot: { fontSize: 13, textAlign: 'center', marginTop: 8, marginBottom: 4 },
});
