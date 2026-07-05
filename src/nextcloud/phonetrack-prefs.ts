/**
 * PhoneTrack visualisation-filter helpers.
 *
 * PhoneTrack persists per-user UI prefs in oc_preferences (via Nextcloud's
 * setUserValue / getUserValue). The visualisation date filter is one of these:
 * `datemin`, `datemax`, `timestampmin`, plus hour/minute/second granularity.
 *
 * We use this to set a sensible default range each time the dashboard loads:
 * "all of yesterday up to now until 06:00 local, then today from 00:00 local"
 * (no end-date filter). The user can browse history on PhoneTrack itself
 * without us interfering — we only re-set on dashboard load.
 */

import { dateBoundsUtc } from "../geo/timezone.js";

const DEFAULT_NIGHT_CUTOFF_HOUR = 6;

/**
 * Returns unix UTC seconds for the start of:
 *   - today 00:00 local time, if `now` is at/after `cutoffHour` local
 *   - yesterday 00:00 local time, if `now` is before `cutoffHour` local
 *
 * The output is what PhoneTrack expects in its `datemin` / `timestampmin`
 * preference values.
 */
export function computePhoneTrackDatemin(now: Date, tz: string, cutoffHour = DEFAULT_NIGHT_CUTOFF_HOUR): number {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(now);
	const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? "";
	let y = Number(get("year"));
	let mo = Number(get("month"));
	let d = Number(get("day"));
	let hour = Number(get("hour"));
	if (hour === 24) hour = 0;

	if (hour < cutoffHour) {
		// Roll back one day in the local calendar
		const prev = new Date(Date.UTC(y, mo - 1, d) - 86400_000);
		y = prev.getUTCFullYear();
		mo = prev.getUTCMonth() + 1;
		d = prev.getUTCDate();
	}

	const dateStr = `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
	return dateBoundsUtc(dateStr, tz).startUtc;
}

/**
 * The values we want to set when applying our default visualisation filter.
 *
 * `applyfilters: "true"` (the literal string, not "1") is required for
 * PhoneTrack's frontend to honour the date range. Verified against the
 * PhoneTrack source at src/App.vue — the UI checks
 * `state.settings.applyfilters !== 'true'` with strict string equality,
 * so "1" / true / "yes" all fail and the filter goes off. The PHP
 * controller (UtilsController::saveOptionValues) stores whatever string
 * we send unchanged, so we set it to "true" to round-trip correctly.
 *
 * Only the `min`-side dates are set — leaving `datemax` etc. unset means
 * "no upper bound." We don't transmit empty strings for the other filter
 * dimensions; the PHP storage is per-key independent so unset keys keep
 * their previous user value.
 */
export function buildPhoneTrackFilterValues(datemin: number): Record<string, string> {
	return {
		applyfilters: "true",
		datemin: String(datemin),
		timestampmin: String(datemin),
	};
}
