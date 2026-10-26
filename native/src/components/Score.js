// A score, shown and taken in the reader's own format.
//
// AniList lets each reader pick how they grade (shared/prefs.js, `scoreFormat`):
// out of 100, out of 10 with a decimal, out of 10, five stars or three faces.
// The library keeps one exact number out of ten; this is the one place the
// phone turns it into what the reader gave and back. It used to be ten stars
// and "x/10" for everyone, so an 85/100 read as "9/10" (owner's iPhone report,
// 2026-10-22).
//
// Stars for the two short scales, the drawn faces for POINT_3 (never emoji,
// whose look is the phone maker's), and a number field for the two scales a
// row of stars cannot hold: a hundred steps, or tenths.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Prefs } from '../shared.js';
import { currentLang, t } from '../i18n.js';
import { Field } from '../ui.js';
import Icon from './Icon.js';

const FACES = ['sad', 'meh', 'happy'];

const formatOf = (format) => (Prefs.SCORE_FORMATS[format] ? format : 'POINT_10');

/** "7,5" in French, "7.5" in English: the same number, written as the reader writes it. */
const number = (n) => (currentLang() === 'fr' ? String(n).replace('.', ',') : String(n));

/** What VoiceOver, a card or a tracker row says for a score, or null for none. */
export function scoreWords(score, format) {
  const f = formatOf(format);
  const shown = Prefs.scoreIn(score, f);
  if (shown === null) return null;
  if (f === 'POINT_3') return t(`scoreFace${shown}`);
  return t('mobileScoreOutOf', [number(shown), String(Prefs.SCORE_FORMATS[f].max)]);
}

/** The short form beside the control: "85/100", "7,5/10", "4/5". */
export function scoreShort(score, format) {
  const f = formatOf(format);
  const shown = Prefs.scoreIn(score, f);
  if (shown === null) return '';
  if (f === 'POINT_3') return t(`scoreFace${shown}`);
  return `${number(shown)}/${Prefs.SCORE_FORMATS[f].max}`;
}

/** The score control of a series' sheet. `onChange` gets the stored score, or null. */
export default function Score({ score, format, colors, onChange }) {
  const f = formatOf(format);
  if (f === 'POINT_100' || f === 'POINT_10_DECIMAL') {
    return <Typed score={score} format={f} colors={colors} onChange={onChange} />;
  }
  if (f === 'POINT_3') return <Faces score={score} colors={colors} onChange={onChange} />;
  return <Stars score={score} format={f} colors={colors} onChange={onChange} />;
}

/**
 * Five or ten stars, the lit one is yours, tapping it again clears it. To
 * VoiceOver it is one control, not ten "black star" buttons: "Score, 7 out of
 * 10, adjustable", swipe up or down to change it (QA report, F-42).
 */
function Stars({ score, format, colors, onChange }) {
  const { max } = Prefs.SCORE_FORMATS[format];
  const shown = Prefs.scoreIn(score, format) ?? 0;
  const set = (n) => onChange(n === 0 ? null : Prefs.scoreOf(n, format));
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t('fieldScore')}
      accessibilityValue={{ text: scoreWords(score, format) ?? t('mobileScoreNone') }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={({ nativeEvent }) => {
        const next = nativeEvent.actionName === 'increment' ? Math.min(max, shown + 1) : Math.max(0, shown - 1);
        if (next !== shown) set(next);
      }}
    >
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <Pressable
          key={n}
          onPress={() => set(shown === n ? 0 : n)}
          hitSlop={{ top: 10, bottom: 10, left: 2, right: 2 }}
          style={styles.star}
        >
          {/* An unlit star is still a star to hit: drawn in the palette's
              muted ink, not the hairline one (1.4:1). */}
          <Text style={{ fontSize: 24, color: n <= shown ? colors.accent : colors.muted }}>★</Text>
        </Pressable>
      ))}
      <Text style={{ color: colors.muted, marginLeft: 6 }}>{scoreShort(score, format)}</Text>
    </View>
  );
}

/** Three faces, one lit. Each is a button that says which grade it is. */
function Faces({ score, colors, onChange }) {
  const shown = Prefs.scoreIn(score, 'POINT_3');
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('fieldScore')}>
      {FACES.map((name, i) => {
        const n = i + 1;
        const on = shown === n;
        return (
          <Pressable
            key={name}
            onPress={() => onChange(on ? null : Prefs.scoreOf(n, 'POINT_3'))}
            accessibilityRole="radio"
            accessibilityLabel={t(`scoreFace${n}`)}
            accessibilityState={{ selected: on }}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            style={[styles.face, { borderColor: on ? colors.accent : 'transparent' }]}
          >
            <Icon name={name} size={28} color={on ? colors.accent : colors.muted} />
          </Pressable>
        );
      })}
      <Text style={{ color: colors.muted, marginLeft: 6 }}>{scoreShort(score, 'POINT_3')}</Text>
    </View>
  );
}

/**
 * Out of 100, or out of 10 with a decimal: typed. Saved when the field is
 * left, refused with a sentence when it is not a score on that scale (101,
 * 7.55), and emptied to take the score off.
 */
function Typed({ score, format, colors, onChange }) {
  const { max } = Prefs.SCORE_FORMATS[format];
  const written = () => {
    const shown = Prefs.scoreIn(score, format);
    return shown === null ? '' : number(shown);
  };
  const [text, setText] = useState(written);
  const [wrong, setWrong] = useState(false);
  // A score changed elsewhere (the website, a sync) is what the field shows.
  useEffect(() => { setText(written()); setWrong(false); }, [score, format]);

  const commit = () => {
    const typed = text.trim().replace(',', '.');
    if (typed === '') {
      setWrong(false);
      if (score != null) onChange(null);
      return;
    }
    const stored = Prefs.scoreOf(typed, format);
    if (stored === null) { setWrong(true); return; }
    setWrong(false);
    if (stored !== score) onChange(stored);
  };

  return (
    <View>
      <Field
        colors={colors}
        label={t('mobileScoreOutOf', [t('fieldScore'), String(max)])}
        value={text}
        onChangeText={setText}
        onEndEditing={commit}
        onSubmitEditing={commit}
        placeholder={`/${max}`}
        keyboardType={format === 'POINT_100' ? 'number-pad' : 'decimal-pad'}
        returnKeyType="done"
      />
      {wrong && (
        <Text style={{ color: colors.danger }} accessibilityLiveRegion="polite">
          {t('mobileScoreInvalid', [format === 'POINT_100' ? '1' : number(0.1), String(max)])}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 0 },
  // 28 points wide and 44 tall with the slop: ten of them fit a 320-point
  // screen, and each is a target a thumb can find.
  star: { width: 28, alignItems: 'center' },
  face: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, borderWidth: 1.5, marginRight: 4 },
});
