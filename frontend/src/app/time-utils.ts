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

/** `HH:MM` of an instant once an offset has put it back on the lived clock.
 *  Private: the only caller left is the degraded arm of [[wallClockInZone]],
 *  and an offset a caller supplies by hand is the thing that stopped being
 *  expressible when the wall clock left the wire (#1532). */
function wallClockAt(instantMs: number, offsetMs: number): string {
  const d = new Date(instantMs + offsetMs);
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
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
