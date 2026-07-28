/**
 * "Does line L serve station S?" — the membership question, asked at the
 * moment a rail label is WRITTEN rather than only by the gate afterwards.
 *
 * `linesAtPoint` answers a different question: which lines pass within a few
 * hundred metres of a point. Near a multi-station site those are not the same
 * thing. At Finchley Road the North London Line's tracks run past on their way
 * to Finchley Road & Frognal — a different station, on a line that never stops
 * here — so a proximity lookup happily reports it, and a reconstruction that
 * only asks "which line reaches both ends" can label a Metropolitan ride
 * "North London line" (2026-06-28, #377).
 *
 * Membership (`stationsOnLine`) is the corrective. It is proximity-inferred and
 * therefore OVER-inclusive — a station near a passing-but-not-stopping line
 * counts as served — so ABSENCE is the strong signal and presence proves
 * little. That asymmetry is what makes this safe to consult as a veto: it can
 * only produce false negatives (failing to reject a wrong line), never a false
 * rejection of a right one. An empty list means the mirror does not know the
 * line at all, which is not "serves nothing" — it asserts nothing.
 *
 * This is the same invariant `checkRailTriples` (src/eval/worldline-feasibility)
 * applies to the finished timeline; consulting it here is what stops a leg from
 * being written into a shape the gate must then reject.
 */

import { expandTubeLineNames } from "./passes/rail-runs.js";

/** The shape this module needs of a station: its name. */
export interface ServedStation {
	name: string;
}

/** Line name → the stations it serves, as `stationsOnLine` (or a fixture's
 *  recorded trace of it) provides. */
export type ServedStationsLookup = (line: string) => Promise<ReadonlyArray<ServedStation>>;

/** Station names compare case- and whitespace-insensitively: the mirror's
 *  station points and a leg's rendered label come from different queries and
 *  differ in incidental spacing. Deliberately NOT shared with the identical
 *  normaliser in `checkRailTriples` — the gate judges this code's output, and
 *  an invariant that imports its subject's helpers can agree with it by
 *  construction. */
function normalizeStationName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Whether `line` is known NOT to serve `station` — the veto form, so the
 * caller's condition reads as the rejection it is.
 *
 * A compound OSM relation ("Circle, Hammersmith & City and Metropolitan
 * Lines") is expanded first: the label names shared track, and it suffices
 * that ONE of the physical lines serves the station. When no component has a
 * known station list the answer is `false` — unknown is not evidence.
 */
export async function lineCannotServe(line: string, station: string, lookup: ServedStationsLookup): Promise<boolean> {
	const target = normalizeStationName(station);
	let known = false;
	for (const component of expandTubeLineNames(line)) {
		const served = await lookup(component);
		if (served.length === 0) continue; // line unknown to the mirror — no assertion
		known = true;
		if (served.some((s) => normalizeStationName(s.name) === target)) return false;
	}
	return known;
}
