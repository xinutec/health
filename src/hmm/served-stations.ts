/**
 * Served-station membership for the station-chain resolver (#364 phase
 * 2) — the read side of `rail_stops_cache` shaped for the decoder.
 *
 * A rail route relation's stop members are the stations the service
 * actually CALLS at — ground truth that proximity membership
 * (`stationLineMemberships`, edges near the node) cannot express: the
 * Metropolitan's fast tracks pass Dollis Hill without stopping, and at
 * the King's Cross complex three differently-named station POIs share
 * one footprint but split cleanly by which services stop where (tube
 * relations call at "King's Cross St Pancras"; NR relations at "London
 * King's Cross" / "London St Pancras").
 *
 * Matching is NAME-only, deliberately: measured on the live mirror
 * (2026-07-19), 6380 of 6381 stops are named, while stop POSITIONS of
 * different stations in a complex sit within ~150 m of each other — a
 * coordinate fallback would re-merge exactly what the names separate.
 * Names are normalized (lowercase, alphanumerics only) so punctuation
 * variants match ("St Pancras" vs "St. Pancras"), and containment is
 * allowed only for long names (≥ MIN_CONTAINMENT_CHARS) so "London St
 * Pancras" matches the POI "London St Pancras International" while
 * "Euston" is refused against "Euston Square" — a real adjacent-station
 * pair, not a naming variant.
 *
 * An absent entry (line matches no relations, or too few stops to trust)
 * means "no membership data", never "serves nothing" — consumers must
 * stay inert without data.
 */

import type { RailStopRelation } from "../geo/osm-rail-stops.js";
import { railRelationsForLine } from "../geo/rail-stops-cache.js";

/** A line's membership entry is trusted only when its relations union to
 *  at least this many named stops — a fragmentary relation (a stub
 *  someone mapped with two stops) must not start penalizing candidates. */
export const MIN_SERVED_STOPS = 5;

/** Containment matching (one normalized name inside the other) is only
 *  believed when the shorter name is at least this long. Catches the
 *  "London St Pancras" ⊂ "London St Pancras International" suffix
 *  pattern while refusing "Euston" ⊂ "Euston Square" — a different
 *  station, not a name variant. */
export const MIN_CONTAINMENT_CHARS = 10;

/** Lowercase alphanumerics only: "King's Cross St. Pancras" and
 *  "King's Cross St Pancras" normalize identically. */
export function normalizeStationName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The normalized names of the stations a line's mirrored relations stop
 *  at, or null when the mirror has no trustworthy data for the line. */
export function servedStationSet(relations: readonly RailStopRelation[], line: string): ReadonlySet<string> | null {
	const matched = railRelationsForLine(relations, line);
	if (matched.length === 0) return null;
	const names = new Set<string>();
	for (const rel of matched) {
		for (const s of rel.stops) if (s.name !== null) names.add(normalizeStationName(s.name));
	}
	return names.size >= MIN_SERVED_STOPS ? names : null;
}

/** Does a station (by POI name) match the line's served-station set?
 *  Exact normalized equality, or guarded containment (see module doc).
 *  Only meaningful when `served` came back non-null. */
export function stationNameServed(served: ReadonlySet<string>, stationName: string): boolean {
	const norm = normalizeStationName(stationName);
	if (served.has(norm)) return true;
	if (norm.length < MIN_CONTAINMENT_CHARS) return false;
	for (const s of served) {
		const shorter = Math.min(s.length, norm.length);
		if (shorter < MIN_CONTAINMENT_CHARS) continue;
		if (s.includes(norm) || norm.includes(s)) return true;
	}
	return false;
}
