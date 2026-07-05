/**
 * Timezone-aware date boundary calculation.
 *
 * PhoneTrack stores UTC unix timestamps. When the user asks for "today"
 * in Europe/Amsterdam (CEST, UTC+2), we need to find the UTC range that
 * corresponds to midnight-to-midnight in their timezone.
 */

// Used by API routes to reject bad `tz` query parameters with a clean 400
// before the value reaches code that crashes deep in Intl. We can't use
// `Intl.supportedValuesOf("timeZone")` because that excludes legacy aliases
// like "UTC" which the rest of the system happily accepts. Instead, ask
// Intl directly: it throws RangeError for any string it doesn't recognise,
// and the constructor cost is small enough that we don't bother caching.
export function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get UTC unix timestamps for the start and end of a date in a given timezone.
 *
 * Example: "2026-05-09" in "Europe/Amsterdam" (CEST, UTC+2)
 *   → start = 2026-05-08T22:00:00Z (midnight local = 22:00 UTC previous day)
 *   → end   = 2026-05-09T22:00:00Z
 */
export function dateBoundsUtc(date: string, tz?: string): { startUtc: number; endUtc: number } {
	if (!tz) {
		// No timezone — assume date boundaries are UTC midnight
		const start = new Date(`${date}T00:00:00Z`);
		const next = new Date(start);
		next.setUTCDate(next.getUTCDate() + 1);
		return {
			startUtc: Math.floor(start.getTime() / 1000),
			endUtc: Math.floor(next.getTime() / 1000),
		};
	}

	// Find the UTC offset for midnight of this date in the given timezone.
	// We do this by formatting a known UTC time in the target timezone and
	// comparing the result to find the offset.
	const utcMidnight = new Date(`${date}T00:00:00Z`);

	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});

	const parts = formatter.formatToParts(utcMidnight);
	const localHour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
	const localDay = Number(parts.find((p) => p.type === "day")?.value ?? 0);
	const dateDay = Number(date.split("-")[2]);

	// The offset is: when it's 00:00 UTC, what time is it locally?
	// If localHour=2 and same day → timezone is UTC+2 → midnight local = 22:00 UTC previous day
	// If localHour=22 and previous day → timezone is UTC-2 → midnight local = 02:00 UTC same day
	let offsetSeconds: number;
	if (localDay === dateDay) {
		// Same day: offset is positive (east of UTC)
		offsetSeconds = localHour * 3600;
	} else if (localDay > dateDay || (dateDay > 27 && localDay === 1)) {
		// Next day: offset is positive and large (e.g. UTC+13)
		offsetSeconds = (localHour + 24) * 3600;
	} else {
		// Previous day: offset is negative (west of UTC)
		offsetSeconds = (localHour - 24) * 3600;
	}

	// Midnight local in UTC = midnight UTC minus the offset
	const startUtc = Math.floor(utcMidnight.getTime() / 1000) - offsetSeconds;
	const endUtc = startUtc + 86400;

	return { startUtc, endUtc };
}

/**
 * Convert a Fitbit DATETIME string ("2026-05-10 03:30:00" or
 * "2026-05-10T03:30:00.000Z" — the mariadb driver may add a misleading
 * Z suffix) to unix UTC seconds, given the user's timezone.
 *
 * The components in the string represent wall-clock time in `tz`. The
 * Z suffix from the driver is decoration we ignore. Without `tz`, we
 * fall back to interpreting components as UTC.
 *
 * Used to align Fitbit-stored heart rate / sleep timestamps with the
 * unix UTC timestamps coming from PhoneTrack so we can join them.
 */
// Reuse the (expensive) Intl.DateTimeFormat instance per tz — instantiating a
// new formatter inside a hot loop costs hundreds of microseconds per call,
// which compounds badly when converting 20k+ Fitbit timestamps for a day.
const tzFormatterCache = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(tz: string): Intl.DateTimeFormat {
	let f = tzFormatterCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		tzFormatterCache.set(tz, f);
	}
	return f;
}

export function fitbitTsToUnix(s: string | Date, tz?: string): number {
	// The mariadb driver returns DATETIME columns as Date objects whose
	// UTC components match the stored wall-clock — coerce to an ISO string
	// so the parser sees a uniform format regardless of source.
	const str = typeof s === "string" ? s : s instanceof Date ? s.toISOString() : String(s);
	const m = str.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
	if (!m) return Number.NaN;
	const [, ys, mos, ds, hs, mis, ss] = m;
	const y = Number(ys);
	const mo = Number(mos);
	const d = Number(ds);
	const h = Number(hs);
	const mi = Number(mis);
	const sec = Number(ss);

	if (!tz) return Date.UTC(y, mo - 1, d, h, mi, sec) / 1000;

	// Round-trip via Intl: pretend the components are UTC, render in tz,
	// measure the divergence, and apply it as the offset.
	const guessUtcMs = Date.UTC(y, mo - 1, d, h, mi, sec);
	const parts = tzFormatter(tz).formatToParts(new Date(guessUtcMs));
	const get = (k: string): number => Number(parts.find((p) => p.type === k)?.value ?? 0);
	const renderedY = get("year");
	const renderedMo = get("month");
	const renderedD = get("day");
	let renderedH = get("hour");
	if (renderedH === 24) renderedH = 0; // some locales render midnight as 24
	const renderedMi = get("minute");
	const renderedS = get("second");

	const renderedAsUtcMs = Date.UTC(renderedY, renderedMo - 1, renderedD, renderedH, renderedMi, renderedS);
	const offsetMs = renderedAsUtcMs - guessUtcMs;
	return (guessUtcMs - offsetMs) / 1000;
}

/**
 * Convert a Fitbit wall-clock DATETIME + tz into a UTC DATETIME string
 * (`YYYY-MM-DD HH:MM:SS`) suitable for storage in a column declared by
 * convention to hold UTC.
 *
 * Returns null when tz is null (no inference signal at write time) or
 * when the wall-clock string is malformed.
 *
 * See `docs/design/timezone.md` for the three-tier
 * storage contract.
 */
export function wallClockToUtcString(wallClock: string | Date, tz: string | null): string | null {
	if (tz === null) return null;
	const unix = fitbitTsToUnix(wallClock, tz);
	if (Number.isNaN(unix)) return null;
	const d = new Date(unix * 1000);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
	);
}
