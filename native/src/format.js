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

/**
 * Bytes, the way a person reads a file size. The same rounding the extension's
 * saved-chapters page uses: one decimal under ten of a unit, none above.
 */
export function bytes(n) {
  if (!n) return '0 kB';
  const units = ['B', 'kB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * "3 new chapters", said in full: the badge's "3 nouv." is an abbreviation
 * for the eye, and VoiceOver read it out letter for letter (QA re-test It.5).
 */
export function newChapters(n) {
  return Number(n) === 1 ? t('mobileNewChaptersOne') : t('mobileNewChaptersMany', [String(n)]);
}

/** A chapter number as a person writes it: "12", not the "12.0" a site sent. */
export function chapterNumber(value) {
  return String(value ?? '').trim().replace(/^(\d+)\.0+$/, '$1');
}

/** A sentence that opens a line starts with a capital, whatever the key says. */
export function opening(text) {
  const s = String(text ?? '');
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}
