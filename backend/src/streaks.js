// Reading streaks: runs of consecutive days with something read.

/**
 * Consecutive days ending today (or yesterday — a streak is not broken until
 * the day it is missed is over), and the longest run anywhere in the list.
 * `days` arrives newest first.
 */
export function streaks(days, today = new Date().toISOString().slice(0, 10)) {
  const set = new Set(days);
  const shift = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  let current = 0;
  let cursor = set.has(today) ? today : shift(today, -1);
  while (set.has(cursor)) { current++; cursor = shift(cursor, -1); }

  let longest = 0;
  for (const day of set) {
    // Count a run only from its earliest day, so each run is walked once.
    if (set.has(shift(day, -1))) continue;
    let n = 0;
    for (let c = day; set.has(c); c = shift(c, 1)) n++;
    if (n > longest) longest = n;
  }
  return { current, longest };
}
