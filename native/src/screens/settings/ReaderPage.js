// What the reader does before you touch it.
//
// Every answer here is the default the injected reader picks up on the next
// chapter — `native/src/prefs.js` says which of the three stores each one lands
// in, and the reader has its own panel for changing them mid-chapter.
import { StyleSheet, Switch, Text, View } from 'react-native';
import Choice from '../../components/Choice.js';
import { Heading, Hint } from '../../ui.js';
import { t } from '../../i18n.js';

/**
 * The switches, in the order the options page asks them.
 *
 * "Open the reader by itself" is not among them, and that is the point: on a
 * phone it is always on. See `native/src/prefs.js` — a chapter opened on a
 * phone has no other purpose for the screen, so the pill would be one tap
 * standing between the reader and the thing they opened.
 */
const TOGGLES = [
  ['autoNext', 'optionsAutoNext'],
  ['hideRead', 'optionsHideRead'],
  ['readerDark', 'optionsReaderDark'],
];

export default function ReaderPage({ prefs, set, colors }) {
  return (
    <>
      <Heading colors={colors}>{t('optionsDefaultMode')}</Heading>
      <Choice
        colors={colors}
        value={prefs.readerMode}
        onChange={(v) => set('readerMode', v)}
        options={[
          { value: 'vertical', label: t('modeVertical') },
          { value: 'ltr', label: t('modeLtr') },
          { value: 'spread', label: t('modeSpread') },
        ]}
      />
      <Hint colors={colors}>{t('optionsReaderHint')}</Hint>

      <Heading colors={colors}>{t('optionsTapZones')}</Heading>
      <Choice
        colors={colors}
        value={prefs.tapZones}
        onChange={(v) => set('tapZones', v)}
        options={[
          { value: 'sides', label: t('optionsTapSides') },
          { value: 'edges', label: t('optionsTapEdges') },
          { value: 'off', label: t('optionsTapOff') },
        ]}
      />
      <Hint colors={colors}>{t('optionsTapHint')}</Hint>

      <Heading colors={colors}>{t('optionsReaderLegend')}</Heading>
      {TOGGLES.map(([key, label]) => (
        <View key={key} style={styles.toggle}>
          <Text style={[styles.label, { color: colors.text }]}>{t(label)}</Text>
          <Switch
            value={!!prefs[key]}
            onValueChange={(v) => set(key, v)}
            trackColor={{ true: colors.accent, false: colors.line }}
          />
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, gap: 16,
  },
  label: { fontSize: 15, flex: 1 },
});
