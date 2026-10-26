// What language the app speaks.
//
// An account preference rather than a device one, and that is the whole point
// of it being here: someone who chose French on the desktop chose it for their
// reading, not for that machine.
import Choice from '../../components/Choice.js';
import { Hint } from '../../ui.js';
import { t } from '../../i18n.js';

export default function AppearancePage({ prefs, set, colors }) {
  return (
    <>
      {/* No theme here: the app is dark only since the redesign (owner,
          October 2026). The account's theme still dresses the website and
          the extension, and is chosen there. */}
      <Choice
        colors={colors}
        value={prefs.uiLang}
        onChange={(v) => set('uiLang', v)}
        // A language names itself: a picker that says "French" to somebody who
        // cannot read English has not helped them.
        options={[
          { value: 'auto', label: t('mobileLanguageAuto') },
          { value: 'en', label: 'English' },
          { value: 'fr', label: 'Français' },
        ]}
      />
      <Hint colors={colors}>{t('mobileLanguageHint')}</Hint>
    </>
  );
}
