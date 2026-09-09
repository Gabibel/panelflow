// How the app looks and what language it speaks.
//
// Both are account preferences rather than device ones, and that is the whole
// point of them being here: someone who chose Dark and French on the desktop
// chose it for their reading, not for that machine.
import Choice from '../../components/Choice.js';
import { Heading, Hint } from '../../ui.js';
import { t } from '../../i18n.js';

export default function AppearancePage({ prefs, set, colors }) {
  return (
    <>
      <Heading colors={colors}>{t('optionsTheme')}</Heading>
      <Choice
        colors={colors}
        value={prefs.theme}
        onChange={(v) => set('theme', v)}
        options={[
          { value: 'system', label: t('optionsThemeSystem') },
          { value: 'light', label: t('optionsThemeLight') },
          { value: 'dark', label: t('optionsThemeDark') },
        ]}
      />
      <Hint colors={colors}>{t('optionsThemeHint').replace(/<[^>]+>/g, '')}</Hint>

      <Heading colors={colors}>{t('optionsUiLanguage')}</Heading>
      <Choice
        colors={colors}
        value={prefs.uiLang}
        onChange={(v) => set('uiLang', v)}
        // A language names itself: a picker that says "French" to somebody who
        // cannot read English has not helped them.
        options={[
          { value: 'auto', label: t('optionsLanguageAuto') },
          { value: 'en', label: 'English' },
          { value: 'fr', label: 'Français' },
        ]}
      />
      <Hint colors={colors}>{t('optionsLanguageHint')}</Hint>
    </>
  );
}
