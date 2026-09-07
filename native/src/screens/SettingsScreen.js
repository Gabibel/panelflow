// The settings, the same ones the extension's options page and the website
// show — because they are the same settings.
//
// Nothing here decides anything: every control writes through `../prefs.js`,
// which knows which of the three stores each answer belongs in, and the values
// a setting may take are `shared/prefs.js`'s list, validated again on the
// server. So a reading direction chosen on this phone is the direction the
// desktop opens with, and a value this screen could not produce is a value the
// account will not accept from anywhere else either.
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { readPrefs, writePrefs } from '../prefs.js';
import { t } from '../i18n.js';
import { Heading, Hint } from '../ui.js';
import Choice from '../components/Choice.js';

/**
 * Every choice on this screen, as data.
 *
 * A list rather than markup because that is what it is: a key, the label above
 * it, and the values it may take with what each is called. Adding a setting is
 * a line here — and if `shared/prefs.js` does not accept the value, the account
 * quietly refuses it, which is the check that matters.
 */
const CHOICES = [
  {
    key: 'theme',
    label: 'optionsTheme',
    hint: 'optionsThemeHint',
    options: [
      ['system', 'optionsThemeSystem'],
      ['light', 'optionsThemeLight'],
      ['dark', 'optionsThemeDark'],
    ],
  },
  {
    key: 'uiLang',
    label: 'optionsUiLanguage',
    hint: 'optionsLanguageHint',
    // 'auto' is a real answer and not the absence of one: it means "ask the
    // phone I am on", which is right for someone who travels between devices.
    options: [['auto', 'optionsLanguageAuto'], ['en', 'English'], ['fr', 'Français']],
    literal: ['en', 'fr'],
  },
  {
    key: 'readerMode',
    label: 'optionsDefaultMode',
    hint: 'optionsReaderHint',
    options: [
      ['vertical', 'modeVertical'],
      ['ltr', 'modeLtr'],
      ['rtl', 'modeRtl'],
      ['spread', 'modeSpread'],
      ['spread-rtl', 'modeSpreadRtl'],
    ],
  },
  {
    key: 'tapZones',
    label: 'optionsTapZones',
    hint: 'optionsTapHint',
    options: [['sides', 'optionsTapSides'], ['edges', 'optionsTapEdges'], ['off', 'optionsTapOff']],
  },
  {
    key: 'checkIntervalMin',
    label: 'optionsCheckEvery',
    hint: 'optionsUpdatesHint',
    options: [
      [60, 'optionsEvery1h'], [180, 'optionsEvery3h'], [360, 'optionsEvery6h'],
      [720, 'optionsEvery12h'], [1440, 'optionsEvery24h'],
    ],
  },
];

/** The switches, in the order the options page asks them. */
const TOGGLES = [
  ['autoShow', 'optionsAutoShow'],
  ['autoNext', 'optionsAutoNext'],
  ['hideRead', 'optionsHideRead'],
  ['readerDark', 'optionsReaderDark'],
];

export default function SettingsScreen({ colors, onChanged }) {
  const [prefs, setPrefs] = useState(null);

  const load = useCallback(async () => setPrefs(await readPrefs()), []);
  useEffect(() => { load(); }, [load]);

  /**
   * Drawn first, saved after.
   *
   * A switch that waits for a round trip before it moves feels broken on a
   * phone, and the write cannot fail in a way the screen could act on — the
   * account refuses an impossible value by ignoring it, and the next `readPrefs`
   * is what would show that.
   */
  const set = async (key, value) => {
    setPrefs((was) => ({ ...was, [key]: value }));
    await writePrefs({ [key]: value });
    // The language and the theme are drawn by the shell around this screen.
    if (key === 'uiLang' || key === 'theme') onChanged?.();
  };

  if (!prefs) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  // The reader's four switches live one level down in `prefs.reader`; the rest
  // are flat. Flattened here so the controls below need not care.
  const valueOf = (key) => (key in prefs ? prefs[key] : prefs.reader[key]);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {CHOICES.map(({ key, label, hint, options, literal }) => (
        <View key={key}>
          <Heading colors={colors}>{t(label)}</Heading>
          <Choice
            colors={colors}
            value={valueOf(key)}
            onChange={(v) => set(key, v)}
            options={options.map(([value, name]) => ({
              value,
              // A language names itself: a picker that says "French" to
              // somebody who cannot read English has not helped them.
              label: literal?.includes(value) ? name : t(name),
            }))}
          />
          {hint && <Hint colors={colors}>{t(hint).replace(/<[^>]+>/g, '')}</Hint>}
        </View>
      ))}

      <Heading colors={colors}>{t('optionsReaderLegend')}</Heading>
      {TOGGLES.map(([key, label]) => (
        <View key={key} style={styles.toggle}>
          <Text style={[styles.toggleLabel, { color: colors.text }]}>{t(label)}</Text>
          <Switch
            value={!!valueOf(key)}
            onValueChange={(v) => set(key, v)}
            trackColor={{ true: colors.accent, false: colors.line }}
          />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  toggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, gap: 16,
  },
  toggleLabel: { fontSize: 15, flex: 1 },
});
