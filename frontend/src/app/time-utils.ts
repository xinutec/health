/**
 * Parse a timestamp from the API as local time, ignoring any UTC suffix.
 *
 * Fitbit records times in the user's local timezone. MariaDB stores them
 * as DATETIME (no timezone). The API may return them with a "Z" suffix
 * which is misleading — they are NOT UTC. This function extracts the
 * time components directly from the string without Date parsing.
 */
export function parseLocalTime(ts: string): { hours: number; minutes: number } {
  const match = /(\d{2}):(\d{2})/.exec(ts);
  if (!match) throw new Error(`Cannot parse time from: ${ts}`);
  return { hours: parseInt(match[1], 10), minutes: parseInt(match[2], 10) };
}

export function formatLocalTime(ts: string): string {
  const { hours, minutes } = parseLocalTime(ts);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

/**
 * Parse a timestamp into epoch milliseconds, treating it as local time.
 * Used for calculating durations and relative positions on charts.
 */
export function localEpoch(ts: string): number {
  // Replace Z suffix and parse without timezone conversion
  const clean = ts.replace(/Z$/, "").replace("T", " ");
  const match = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(clean);
  if (!match) throw new Error(`Cannot parse timestamp: ${ts}`);
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/**
 * Format a Date as YYYY-MM-DD in a specific timezone.
 * Uses Intl.DateTimeFormat so it works correctly regardless of the system timezone.
 */
export function formatDateInTz(d: Date, tz?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  if (tz) opts.timeZone = tz;

  const parts = new Intl.DateTimeFormat("en-CA", opts).formatToParts(d);
  const year = parts.find(p => p.type === "year")!.value;
  const month = parts.find(p => p.type === "month")!.value;
  const day = parts.find(p => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

/** Get the browser's IANA timezone name */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Today's date in the browser's timezone */
export function todayLocal(): string {
  return formatDateInTz(new Date(), browserTimezone());
}
