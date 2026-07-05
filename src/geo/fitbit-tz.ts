/**
 * TzSource — determine the IANA timezone a Fitbit wall-clock row was recorded in.
 *
 * Fitbit's intraday endpoints return wall-clock strings ("22:39:00") with no
 * timezone information. The "right" tz to interpret them by is the watch's tz
 * AT THE MOMENT OF RECORDING, which Fitbit does not preserve. The full design
 * including motivation, fallback chain, and edge cases is in TIMEZONE.md.
 *
 * This module produces the `tz` value written to per-row `tz` columns at
 * sync time. Forward sync builds a real `TzSource` from PhoneTrack fixes +
 * Fitbit profile.timezone. Backward backfill uses `NULL_TZ_SOURCE`, leaving
 * rows with `tz=NULL` for the Phase 3 backfill CLI to fill in later.
 */

import tzLookup from "tz-lookup";
import type { RawTrackPoint } from "../nextcloud/phonetrack.js";
import { fitbitTsToUnix } from "./timezone.js";

export interface TzSource {
	/** Given a Fitbit wall-clock row (date + time), return the inferred
	 *  recording tz, or null if no signal is available. */
	forWallClock(date: string, time: string): string | null;
}

/** Sentinel used by the backward backfill path: never infers, always returns
 *  null. Rows get `tz=NULL` which the Phase 3 backfill CLI fills in. */
export const NULL_TZ_SOURCE: TzSource = {
	forWallClock: () => null,
};

const FIX_SEARCH_WINDOW_S = 6 * 60 * 60;
/** Hardcoded seed for a single-user deployment where profileTz is briefly
 *  null (first-link, profile call failed). Multi-user should pass home_tz
 *  at construction time so the seed is per-user. */
const HARDCODED_FALLBACK_TZ = "Europe/Amsterdam";

interface BuildForwardTzSourceArgs {
	/** PhoneTrack fixes spanning the sync window, in any order. */
	fixes: RawTrackPoint[];
	/** Result of /1/user/-/profile.json, or null if the call failed. */
	profileTz: string | null;
}

export function buildForwardTzSource(args: BuildForwardTzSourceArgs): TzSource {
	const { fixes, profileTz } = args;
	// Sort once so the per-row binary search runs in O(log N).
	const sorted = [...fixes].sort((a, b) => a.ts - b.ts);
	const tsArray = sorted.map((p) => p.ts);
	// Memo by rounded lat/lon (~3dp = ~100m) since clustered fixes map to
	// the same tz. Saves repeated tz-lookup calls within a sync run.
	const tzLookupCache = new Map<string, string>();

	const lookupTz = (lat: number, lon: number): string => {
		const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
		let value = tzLookupCache.get(key);
		if (value === undefined) {
			value = tzLookup(lat, lon);
			tzLookupCache.set(key, value);
		}
		return value;
	};

	return {
		forWallClock(date: string, time: string): string | null {
			if (sorted.length === 0) {
				return profileTz ?? null;
			}
			// Seed: convert wall-clock to approximate UTC unix using profileTz
			// (or HARDCODED_FALLBACK_TZ if profileTz is null). A ±2h offset
			// error in the seed is well inside the ±6h search window.
			const seedTz = profileTz ?? HARDCODED_FALLBACK_TZ;
			const seedUtcUnix = fitbitTsToUnix(`${date} ${time}`, seedTz);
			if (Number.isNaN(seedUtcUnix)) {
				return profileTz ?? null;
			}

			// Binary-search nearest fix in time.
			const nearestIdx = nearestIndex(tsArray, seedUtcUnix);
			const nearestFix = sorted[nearestIdx];
			const delta = Math.abs(nearestFix.ts - seedUtcUnix);
			if (delta > FIX_SEARCH_WINDOW_S) {
				return profileTz ?? null;
			}
			return lookupTz(nearestFix.lat, nearestFix.lon);
		},
	};
}

/** Binary-search the index in `sortedTs` whose value is closest to `target`.
 *  Pre: sortedTs is non-empty and sorted ascending. */
function nearestIndex(sortedTs: number[], target: number): number {
	let lo = 0;
	let hi = sortedTs.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sortedTs[mid] < target) lo = mid + 1;
		else hi = mid;
	}
	// lo is the first index with value >= target, or the last index if all values < target.
	if (lo > 0) {
		const prev = sortedTs[lo - 1];
		const cur = sortedTs[lo];
		if (Math.abs(target - prev) < Math.abs(cur - target)) return lo - 1;
	}
	return lo;
}
