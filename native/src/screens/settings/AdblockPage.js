// The ad blocker's exceptions, from the phone.
//
// The extension's options page and the website both had this field; the phone
// only *read* the list (BrowserScreen hands it to rn-adblock.js) and offered
// no way to change it. A site that breaks under the blocker — some players
// refuse to start without their own scripts — could be excused from a desk
// and not from a train, which is where it is being watched.
//
// One host per line, the way the other two write it. The list is an account
// preference (shared/prefs.js validates it server-side: hosts only, capped),
// so a domain excused here is excused in the browser at home as well, and the
// same words as the options page so the two screens read as one setting.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '../../i18n.js';
import { Heading, Hint } from '../../ui.js';

export default function AdblockPage({ prefs, set, colors }) {
  // Edited as text and written as a list: a field that wrote on every
  // keystroke would push a half-typed host to the account with each letter.
  const [text, setText] = useState((prefs.whitelist || []).join('\n'));
  useEffect(() => { setText((prefs.whitelist || []).join('\n')); }, [prefs.whitelist]);

  const commit = () => {
    const hosts = text.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
    // Only if something changed: a blur is not an edit.
    if (JSON.stringify(hosts) !== JSON.stringify(prefs.whitelist || [])) set('whitelist', hosts);
  };

  return (
    <>
      <Heading colors={colors}>{t('optionsAdblockLegend')}</Heading>
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>{t('optionsWhitelistLabel')}</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          onBlur={commit}
          onSubmitEditing={commit}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="example.com"
          placeholderTextColor={colors.muted}
          accessibilityLabel={t('optionsWhitelistLabel')}
          style={[styles.input, {
            color: colors.text, backgroundColor: colors.surface, borderColor: colors.line,
          }]}
        />
      </View>
      <Hint colors={colors}>{t('optionsAdblockHint')}</Hint>
    </>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: 12 },
  label: { fontSize: 13, marginBottom: 6 },
  input: {
    borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 15,
    minHeight: 110, textAlignVertical: 'top',
  },
});
