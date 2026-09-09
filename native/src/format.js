// The two things this app prints that are not words.
//
// Both are here rather than in the screens that draw them, because a duration
// written two ways in two places is the same fact reported twice — and the
// second one is always the one nobody updates.
import { t } from './i18n.js';

/**
 * Seconds, as the sentence a reader would say. Under a minute stays seconds:
 * "0 min" is not a truer answer than "40 s", it is a rounder one.
 */
export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return t('durationSeconds', [String(s)]);
  const mins = Math.round(s / 60);
  if (mins < 60) return t('durationMinutes', [String(mins)]);
  return t('durationHours', [String(Math.floor(mins / 60)), String(mins % 60).padStart(2, '0')]);
}

/** The reader's own calendar day, matching the one the core stamps reads with. */
export function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
