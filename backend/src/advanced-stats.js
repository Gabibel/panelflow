// The detailed statistics PanelFlow Premium adds on top of the free ones.
//
// Everything here is computed by the server, from the account's history, and
// only for an account the server itself knows is Premium (routes/history.js
// asks before calling). A client that hides a section is not a paywall; a
// server that never sends it is.
//
// Four answers, each to a question a reader asks:
//
//   weeks / months   "am I reading more or less than before?"
//   year             "what did my year look like?" (this year and the last)
//   hours / weekdays "when do I read?"
//   catchUp          "when will I have caught up with this series?"
//
// The history has one row per chapter per day (db.js), with the day the
// reader's device called it and `read_at`, the server's UTC moment of the last
// report. Hours are read from `read_at` shifted to the reader's clock (`tz`,
// minutes east of UTC, sent by the client); days and weekdays from `day`,
// which is already the reader's own.
import { db } from './db.js';
import { streaks } from './streaks.js';

/** The weeks and months the charts go back. */
export const WEEKS = 26;
export const MONTHS = 24;
/** How far back a series' reading pace is measured. */
export const PACE_DAYS = 56;

/** A UTC offset in minutes the client may send, or 0. */
export function tzOffset(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= -840 && n <= 840 ? n : 0;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}
/** The Monday on or before `day`. */
export function weekOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return shiftDay(day, -((d.getUTCDay() + 6) % 7));
}

/** Every week from `WEEKS` ago to this one, zeros included: a chart with gaps closed up lies. */
export function fillWeeks(rows, today) {
  const by = new Map(rows.map((r) => [r.week, r]));
  const out = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const week = shiftDay(weekOf(today), -7 * i);
    const r = by.get(week);
    out.push({ week, chapters: Number(r?.chapters ?? 0), seconds: Number(r?.seconds ?? 0) });
  }
  return out;
}

export function fillMonths(rows, today) {
  const by = new Map(rows.map((r) => [r.month, r]));
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const month = d.toISOString().slice(0, 7);
    const r = by.get(month);
    out.push({ month, chapters: Number(r?.chapters ?? 0), seconds: Number(r?.seconds ?? 0) });
  }
  return out;
}

/**
 * When the reader will have caught up with each series they are reading, at
 * the pace of the last PACE_DAYS. A series nobody has read lately has no
 * pace, and no date is invented for it: `weeks` is null.
 */
export function catchUp(rows) {
  return rows
    .map((r) => {
      const latest = Number(r.latest);
      const at = Number(r.at);
      if (!Number.isFinite(latest) || !Number.isFinite(at)) return null;
      const behind = Math.max(0, Math.round((latest - at) * 10) / 10);
      if (behind <= 0) return null;
      const perWeek = Number(r.recent) / (PACE_DAYS / 7);
      return {
        id: r.id,
        title: r.title,
        coverUrl: r.cover_url ?? null,
        behind,
        perWeek: Math.round(perWeek * 10) / 10,
        weeks: perWeek > 0 ? Math.ceil(behind / perWeek) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.weeks ?? Infinity) - (b.weeks ?? Infinity) || a.behind - b.behind)
    .slice(0, 10);
}

/**
 * The detailed statistics for one account, narrowed to one kind of work when
 * `medium` is given, as `GET /api/history/stats` narrows the free ones.
 */
export async function advancedStats(userId, { medium = null, tz = 0, today = isoDay(new Date()) } = {}) {
  const H = medium
    ? 'history h JOIN library l ON l.id = h.library_id WHERE h.user_id = ? AND l.medium = ?'
    : 'history h WHERE h.user_id = ?';
  const hArgs = medium ? [userId, medium] : [userId];
  // The same rows, with their series beside them, for the lists that name it.
  const T = `history h JOIN library l ON l.id = h.library_id WHERE h.user_id = ?${medium ? ' AND l.medium = ?' : ''}`;
  const since = (days) => shiftDay(today, -days);
  const year = Number(today.slice(0, 4));

  const [weeks, months, hours, weekdays, firsts, pace] = await Promise.all([
    // date(day, '-6 days', 'weekday 1'): the Monday on or before the day.
    db.prepare(`
      SELECT date(h.day, '-6 days', 'weekday 1') AS week, COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds
      FROM ${H} AND h.day >= ? GROUP BY week
    `).all(...hArgs, shiftDay(weekOf(today), -7 * (WEEKS - 1))),
    db.prepare(`
      SELECT substr(h.day, 1, 7) AS month, COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds
      FROM ${H} AND h.day >= ? GROUP BY month
    `).all(...hArgs, `${fillMonths([], today)[0].month}-01`),
    db.prepare(`
      SELECT CAST(strftime('%H', h.read_at, ?) AS INTEGER) AS hour, COUNT(*) AS chapters
      FROM ${H} GROUP BY hour
    `).all(`${tz} minutes`, ...hArgs),
    // %w: 0 is Sunday. Turned into Monday-first below.
    db.prepare(`
      SELECT CAST(strftime('%w', h.day) AS INTEGER) AS weekday, COUNT(*) AS chapters
      FROM ${H} GROUP BY weekday
    `).all(...hArgs),
    // The day each series was first read, for "new series this year".
    db.prepare(`
      SELECT h.library_id AS id, MIN(h.day) AS first FROM ${H} GROUP BY h.library_id
    `).all(...hArgs),
    // The series being read, how far the bookmark is, how far the site is,
    // and how many chapters of it were read lately.
    db.prepare(`
      SELECT l.id, l.title, l.cover_url, l.last_known_chapter AS latest, p.furthest_num AS at,
             (SELECT COUNT(*) FROM history r WHERE r.user_id = l.user_id AND r.library_id = l.id AND r.day >= ?) AS recent
      FROM library l JOIN progress p ON p.library_id = l.id AND p.user_id = l.user_id
      WHERE l.user_id = ? AND l.deleted = 0 AND l.folder = 'reading' ${medium ? 'AND l.medium = ?' : ''}
    `).all(since(PACE_DAYS), userId, ...(medium ? [medium] : [])),
  ]);

  const hourly = Array.from({ length: 24 }, () => 0);
  for (const r of hours) if (r.hour >= 0 && r.hour < 24) hourly[r.hour] = Number(r.chapters);
  const daily = Array.from({ length: 7 }, () => 0);
  for (const r of weekdays) daily[(Number(r.weekday) + 6) % 7] = Number(r.chapters);

  const recap = async (y) => {
    const [totals, top, days] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS chapters, COALESCE(SUM(h.seconds), 0) AS seconds,
               COUNT(DISTINCT h.library_id) AS series, COUNT(DISTINCT h.day) AS days
        FROM ${H} AND substr(h.day, 1, 4) = ?
      `).get(...hArgs, String(y)),
      db.prepare(`
        SELECT h.library_id AS id, l.title, l.cover_url, COUNT(*) AS chapters
        FROM ${T} AND substr(h.day, 1, 4) = ?
        GROUP BY h.library_id ORDER BY chapters DESC LIMIT 5
      `).all(...hArgs, String(y)),
      db.prepare(`SELECT DISTINCT h.day AS day FROM ${H} AND substr(h.day, 1, 4) = ? ORDER BY h.day DESC`).all(...hArgs, String(y)),
    ]);
    const monthsOfYear = months.filter((m) => m.month.startsWith(`${y}-`));
    const best = monthsOfYear.reduce((a, b) => (Number(b.chapters) > Number(a?.chapters ?? -1) ? b : a), null);
    return {
      year: y,
      chapters: Number(totals.chapters),
      seconds: Number(totals.seconds),
      series: Number(totals.series),
      days: Number(totals.days),
      newSeries: firsts.filter((f) => String(f.first).startsWith(`${y}-`)).length,
      bestMonth: best && Number(best.chapters) > 0 ? { month: best.month, chapters: Number(best.chapters) } : null,
      longestStreak: streaks(days.map((d) => d.day), `${y}-12-31`).longest,
      top: top.map((s) => ({ id: s.id, title: s.title, coverUrl: s.cover_url ?? null, chapters: Number(s.chapters) })),
    };
  };

  return {
    weeks: fillWeeks(weeks, today),
    months: fillMonths(months, today),
    hours: hourly,
    weekdays: daily,
    year: await recap(year),
    lastYear: await recap(year - 1),
    catchUp: catchUp(pace),
  };
}
