/** The weight chart's day axis and its first-day estimate, kept apart from the
 *  component so they test without a DOM. */

/** One series on the day axis: a value or null per day, and whether the first
 *  day's value is an estimate rather than a reading. */
export interface DaySeries {
  values: (number | null)[];
  estimatedFirst: boolean;
}

const DAY_MS = 86_400_000;

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. UTC on both sides, so a DST
 *  change between them cannot shorten a day. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Every date from `since` to `until`, inclusive. */
export function dayAxis(since: string, until: string): string[] {
  const out: string[] = [];
  const n = daysBetween(since, until);
  for (let i = 0; i <= n; i++) {
    // dev-lint: allow-utc-calendar-day a UTC-midnight instant built from the date itself, stepped in whole days
    out.push(new Date(Date.parse(`${since}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

/** Place readings on the day axis. When the first day has no reading, it is
 *  ESTIMATED on the straight line from the last reading before the window to
 *  the first one inside it — the same line the chart draws between readings.
 *  With no reading inside the window there is nothing to aim at, so no
 *  estimate. */
export function placeOnDays(
  days: string[],
  readings: { date: string; value: number }[],
  before: { date: string; value: number } | null,
): DaySeries {
  const at = new Map(readings.map((r) => [r.date, r.value]));
  const values = days.map((d) => at.get(d) ?? null);
  const firstIdx = values.findIndex((v) => v !== null);
  if (values.length === 0 || values[0] !== null || before === null || firstIdx < 0) {
    return { values, estimatedFirst: false };
  }
  const first = values[firstIdx]!;
  const span = daysBetween(before.date, days[firstIdx]);
  const into = daysBetween(before.date, days[0]);
  values[0] = before.value + ((first - before.value) * into) / span;
  return { values, estimatedFirst: true };
}
