/**
 * opening_hours subset parser.
 *
 * The OSM mirror stores every venue's full tag set (osm_points.tags_json /
 * osm_lines.tags_json) and roughly a third of venue-class POIs carry
 * `opening_hours`. The venue-plausibility scorer uses "was this venue open
 * during the stay" as *weighted evidence* — never a veto, because OSM hours
 * go stale.
 *
 * The grammar here is a deliberate subset of the OSM opening_hours syntax:
 * the common shapes (day ranges/lists, multiple time ranges, past-midnight
 * wrap, "off", "24/7", trailing "PH off") cover the overwhelming majority
 * of real tags. Everything else — sunrise/sunset, month/week selectors,
 * open-ended ranges — parses to **null**, which downstream means "no
 * evidence", NOT "closed". Honesty about the parser's limits is the
 * contract; a wrong "closed" verdict would poison the scorer.
 */

const DAY_NAMES = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;

export interface TimeRange {
	/** Minutes since local midnight, inclusive. */
	startMin: number;
	/** Minutes since local midnight, exclusive. May exceed 1440 when the
	 *  range wraps past midnight ("20:00-02:00" → 1200..1560); the overflow
	 *  is evaluated against the *next* day by {@link isOpenAt}. */
	endMin: number;
}

/** Seven entries, index 0 = Monday .. 6 = Sunday (OSM day order). */
export type WeekSpec = ReadonlyArray<readonly TimeRange[]>;

/** Parse a day token list ("Mo-Fr", "Sa,Su", "Mo,We-Fr", wrapping "Sa-Mo")
 *  into day indices. PH/SH tokens are dropped (holidays unknowable here).
 *  Returns null on any unrecognised token; returns the empty array when the
 *  spec consisted *only* of PH/SH (caller skips the rule). */
function parseDaySpec(spec: string): number[] | null {
	const days = new Set<number>();
	let sawHoliday = false;
	for (const token of spec.split(",")) {
		const t = token.trim().toLowerCase();
		if (t === "ph" || t === "sh") {
			sawHoliday = true;
			continue;
		}
		const m = t.match(/^([a-z]{2})(?:-([a-z]{2}))?$/);
		if (!m) return null;
		const from = DAY_NAMES.indexOf(m[1] as (typeof DAY_NAMES)[number]);
		if (from < 0) return null;
		if (m[2]) {
			const to = DAY_NAMES.indexOf(m[2] as (typeof DAY_NAMES)[number]);
			if (to < 0) return null;
			// Wrapping ranges (Sa-Mo) walk forward through the week.
			for (let d = from; ; d = (d + 1) % 7) {
				days.add(d);
				if (d === to) break;
			}
		} else {
			days.add(from);
		}
	}
	if (days.size === 0) return sawHoliday ? [] : null;
	return [...days];
}

/** Parse "HH:MM-HH:MM(, HH:MM-HH:MM)*" into ranges. Ranges that end at or
 *  before their start wrap past midnight. Returns null on anything else. */
function parseTimeSpec(spec: string): TimeRange[] | null {
	const ranges: TimeRange[] = [];
	for (const token of spec.split(",")) {
		const m = token.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
		if (!m) return null;
		const startMin = Number(m[1]) * 60 + Number(m[2]);
		let endMin = Number(m[3]) * 60 + Number(m[4]);
		if (startMin > 24 * 60 || endMin > 24 * 60) return null;
		if (endMin <= startMin) endMin += 24 * 60; // wraps past midnight
		ranges.push({ startMin, endMin });
	}
	return ranges.length > 0 ? ranges : null;
}

/**
 * Parse an OSM `opening_hours` value into per-day open ranges, or null when
 * the value uses syntax outside the supported subset. Later rules override
 * earlier ones for the days they mention (OSM semantics: "Mo-Sa 08:00-18:00;
 * We off" closes Wednesday).
 */
export function parseOpeningHours(value: string): WeekSpec | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (trimmed === "24/7") {
		return DAY_NAMES.map(() => [{ startMin: 0, endMin: 24 * 60 }]);
	}
	const week: Array<TimeRange[] | null> = DAY_NAMES.map(() => null);
	let anyRule = false;
	for (const rule of trimmed.split(";")) {
		const r = rule.trim();
		if (r === "") continue;
		// Split the rule into a leading day spec (letters/commas/hyphens
		// only) and the remainder (times or off/closed). A rule may have no
		// day spec at all ("08:00-20:00" = every day).
		const m = r.match(/^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)?\s*(.*)$/);
		const daySpec = m?.[1];
		const rest = (m?.[2] ?? "").trim();
		let days: number[];
		if (daySpec) {
			const parsed = parseDaySpec(daySpec.replace(/\s+/g, ""));
			if (parsed === null) return null;
			if (parsed.length === 0) continue; // pure PH/SH rule — skip
			days = parsed;
		} else {
			days = [0, 1, 2, 3, 4, 5, 6];
		}
		let ranges: TimeRange[];
		if (rest.toLowerCase() === "off" || rest.toLowerCase() === "closed") {
			ranges = [];
		} else {
			const parsed = parseTimeSpec(rest);
			if (parsed === null) return null;
			ranges = parsed;
		}
		for (const d of days) week[d] = ranges;
		anyRule = true;
	}
	if (!anyRule) return null;
	return week.map((d) => d ?? []);
}

/** Is the venue open at `minuteOfDay` on `dayIdx` (0 = Monday)? Checks the
 *  day's own ranges plus the previous day's past-midnight overflow. */
export function isOpenAt(spec: WeekSpec, dayIdx: number, minuteOfDay: number): boolean {
	for (const r of spec[dayIdx]) {
		if (minuteOfDay >= r.startMin && minuteOfDay < r.endMin) return true;
	}
	const prev = spec[(dayIdx + 6) % 7];
	for (const r of prev) {
		if (r.endMin > 24 * 60 && minuteOfDay + 24 * 60 >= r.startMin && minuteOfDay + 24 * 60 < r.endMin) return true;
	}
	return false;
}

// Reuse the (expensive) Intl.DateTimeFormat per tz — same rationale as
// timezone.ts: instantiating one inside a per-minute loop compounds badly.
const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();
function weekdayFormatter(tz: string): Intl.DateTimeFormat {
	let f = weekdayFormatterCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		weekdayFormatterCache.set(tz, f);
	}
	return f;
}

const WEEKDAY_IDX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function localDayMinute(tsUnix: number, tz: string): { dayIdx: number; minuteOfDay: number } {
	const parts = weekdayFormatter(tz).formatToParts(new Date(tsUnix * 1000));
	const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? "";
	let hour = Number(get("hour"));
	if (hour === 24) hour = 0; // some locales render midnight as 24
	return { dayIdx: WEEKDAY_IDX[get("weekday")] ?? 0, minuteOfDay: hour * 60 + Number(get("minute")) };
}

/**
 * Fraction of the stay `[startUnix, endUnix)` during which the venue is
 * open, sampled per minute in the venue's local timezone. A zero-length
 * window is evaluated as the instant at its start. Returns a value in [0, 1].
 */
export function openFractionDuring(spec: WeekSpec, startUnix: number, endUnix: number, tz: string): number {
	if (endUnix <= startUnix) {
		const { dayIdx, minuteOfDay } = localDayMinute(startUnix, tz);
		return isOpenAt(spec, dayIdx, minuteOfDay) ? 1 : 0;
	}
	let open = 0;
	let total = 0;
	for (let t = startUnix; t < endUnix; t += 60) {
		const { dayIdx, minuteOfDay } = localDayMinute(t, tz);
		if (isOpenAt(spec, dayIdx, minuteOfDay)) open++;
		total++;
	}
	return open / total;
}
