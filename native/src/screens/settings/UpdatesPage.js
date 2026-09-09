// How often this phone goes looking for new chapters.
//
// Only while the app is running: the server keeps watching the sites it can
// reach on its own and hands over what it found the next time this client asks,
// which is why checking rarely costs less than it looks.
import Choice from '../../components/Choice.js';
import { Heading, Hint } from '../../ui.js';
import { t } from '../../i18n.js';

export default function UpdatesPage({ prefs, set, colors }) {
  return (
    <>
      <Heading colors={colors}>{t('optionsCheckEvery')}</Heading>
      <Choice
        colors={colors}
        value={prefs.checkIntervalMin}
        onChange={(v) => set('checkIntervalMin', v)}
        options={[
          { value: 60, label: t('optionsEvery1h') },
          { value: 180, label: t('optionsEvery3h') },
          { value: 360, label: t('optionsEvery6h') },
          { value: 720, label: t('optionsEvery12h') },
          { value: 1440, label: t('optionsEvery24h') },
        ]}
      />
      <Hint colors={colors}>{t('optionsUpdatesHint')}</Hint>
    </>
  );
}
