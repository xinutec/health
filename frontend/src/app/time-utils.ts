/**
 * The HH:MM a wall-clock timestamp shows, read straight off the string.
 *
 * Fitbit records times in the zone the watch was in; MariaDB stores them as
 * DATETIME, and the API stamps every DATETIME with a "Z" that is not true of
 * these (#340). Reading the components textually is correct for a wall clock
 * BECAUSE it never consults a zone — there is none to consult.
 *
 * ⚠ This is for LABELS. Anything that measures — a duration, a position, a
 * comparison between two rows — must use the `_utc` column the API serves
 * beside the wall clock, or it will be wrong by the offset on a night or day
 * the wearer changed zones. `localEpoch`, which used to fake an epoch out of
 * these components for exactly that purpose, is gone for that reason.
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

/**
 * The true instant a wall-clock row happened, in epoch milliseconds.
 *
 * `tsUtc` is the API's `_utc` sibling column and is the answer whenever it is
 * present. ⚠ When it is absent the wall clock is read AS THOUGH it were UTC:
 * that is a DEGRADATION, not a default. Relative geometry within one day comes
 * out identical — which is why it is safe for a chart — but the value is wrong
 * by the zone offset as an absolute instant, and two rows either side of a
 * zone change will be wrong RELATIVE to each other too. Measured 2026-09-11:
 * no `sleep_stages` row in production lacks `ts_utc`, so this is for old
 * payloads only. Never persist or compare across days on a degraded value.
 */
export function rowInstant(ts: string, tsUtc: string | null | undefined): number {
  return Date.parse(tsUtc ?? asIfUtc(ts));
}

/**
 * `wall − instant`: the zone offset the row was recorded in, in milliseconds.
 *
 * Zero when `tsUtc` is missing, because the degraded instant above IS the wall
 * clock — so a caller that adds this offset gets the wall clock back either
 * way, and never silently shifts a chart by an offset it did not measure.
 */
export function wallOffsetMs(ts: string, tsUtc: string | null | undefined): number {
  return Date.parse(asIfUtc(ts)) - rowInstant(ts, tsUtc);
}

/** `HH:MM` of an instant once an offset has put it back on the lived clock. */
export function wallClockAt(instantMs: number, offsetMs: number): string {
  const d = new Date(instantMs + offsetMs);
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

/** A wall clock read as a UTC instant — the components, no zone applied. */
function asIfUtc(ts: string): string {
  return ts.endsWith("Z") ? ts : `${ts}Z`;
}

/**
 * The wall clock an instant showed IN A NAMED ZONE.
 *
 * The honest form of [[wallClockAt]]: that one takes a single offset measured
 * from one row, which is right for an ordinary night and approximate for one
 * where the zone changed — a fixed offset cannot bend. A zone can, so this
 * asks `Intl` to apply it at the instant in question.
 *
 * ⚠ `tz` ABSENT IS A DEGRADATION, not a default. Reading the instant as UTC
 * reproduces the old geometry exactly on a night lived in UTC and is wrong by
 * the offset anywhere else. Every `sleep_stages` row in production carries a
 * zone; this arm is for a payload that predates the column.
 */
export function wallClockInZone(instantMs: number, tz: string | null | undefined): string {
	if (!tz) return wallClockAt(instantMs, 0);
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(instantMs));
	// `en-GB` renders "24:05" at midnight in some runtimes; normalise the hour.
	return parts.startsWith("24:") ? `00:${parts.slice(3)}` : parts;
}
