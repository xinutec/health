/**
 * Which of several lines sharing a track did the train actually run on?
 *
 * `lineUnderTheTrack` separates candidates by where the ride's fixes were, and
 * that works whenever the lines diverge. It cannot work where they DON'T: for
 * seven kilometres out of Wembley Park the Metropolitan and the Jubilee run on
 * the same rails, so every fix supports both and the label is dropped. That
 * dropped label is what leaves a fragment unmergeable — `provenSameLine` needs
 * both fragments named — and it is why 2026-06-23's one continuous Metropolitan
 * ride reads as two rides either side of a phantom Finchley Road interchange.
 *
 * The lines are not actually indistinguishable there. They differ in where they
 * STOP: the Metropolitan runs fast past Neasden, Dollis Hill, Willesden Green
 * and Kilburn; the Jubilee calls at all of them. Same rails, same distance,
 * roughly double the journey time. So the elapsed time IS the discriminator,
 * and the stop lists needed to use it are already mirrored in
 * `rail_stops_cache` — ordered `stop`-role relation members, the stations a
 * service actually calls at, which is exactly what proximity membership
 * (`stationsOnLine`) structurally cannot express.
 *
 * Deliberately a most-likely call rather than a proof. Two lines that share
 * track are never *definitely* separable from a duration — a held train, a slow
 * approach, a generous segment boundary all blur it — so this returns a winner
 * only when one candidate fits materially better than the rest, and null
 * otherwise. Null leaves the label bare, which is where the caller already was.
 */

import { normalizeStationName } from "../hmm/served-stations.js";
import type { RailStopRelation } from "./osm-rail-stops.js";
import { railRelationsForLine } from "./rail-stops-cache.js";

/** Seconds a metro service spends per inter-station hop, including the dwell.
 *  The same crude figure `interchange-split.ts` uses to order interchange
 *  candidates — it only has to separate "called at four stations" from "ran
 *  straight through", not predict arrival to the minute. */
const PER_STOP_S = 120;

/** How much better the best candidate's prediction must fit than the runner
 *  up's before the difference is called evidence, as a fraction of the
 *  observed duration. Below this the two stopping patterns explain the ride
 *  about equally and naming one would be a guess dressed as a finding. */
const MIN_SEPARATION_FRACTION = 0.25;

/** Where a station sits in a relation's ordered stop list, or -1. */
function indexOfStop(rel: RailStopRelation, station: string): number {
	const target = normalizeStationName(station);
	return rel.stops.findIndex((s) => s.name !== null && normalizeStationName(s.name) === target);
}

/**
 * How long this line would take between the two stations, in seconds, given
 * the stations it calls at in between — or null when the mirror cannot say
 * (no relation for the line, or none that stops at both endpoints).
 *
 * A relation is ONE direction of a service, so the endpoints may appear in
 * either order; the hop count is the absolute distance between them. Where a
 * line has several relations (directions, service variants) the FEWEST hops
 * wins: a semi-fast variant that skips stations is still that line, and the
 * question being asked is what the observed train could have been.
 */
export function expectedDurationS(
	line: string,
	board: string,
	alight: string,
	relations: readonly RailStopRelation[],
): number | null {
	let fewestHops: number | null = null;
	for (const rel of railRelationsForLine(relations, line)) {
		const b = indexOfStop(rel, board);
		const a = indexOfStop(rel, alight);
		if (b < 0 || a < 0) continue;
		const hops = Math.abs(a - b);
		if (hops === 0) continue;
		if (fewestHops === null || hops < fewestHops) fewestHops = hops;
	}
	return fewestHops === null ? null : fewestHops * PER_STOP_S;
}

/**
 * The candidate whose stopping pattern best explains a ride of `elapsedS`
 * between the two stations, or null when the evidence does not separate them.
 *
 * Null on: fewer than two candidates the mirror knows (nothing to compare a
 * good fit against — a single line fitting well is not evidence it was ridden
 * rather than its unmapped rival), or a best fit that is not materially better
 * than the runner up.
 */
export function pickLineByStoppingPattern(
	candidates: readonly string[],
	board: string,
	alight: string,
	elapsedS: number,
	relations: readonly RailStopRelation[],
): string | null {
	if (elapsedS <= 0) return null;
	const scored: Array<{ line: string; error: number }> = [];
	for (const line of candidates) {
		const expected = expectedDurationS(line, board, alight, relations);
		if (expected === null) continue;
		scored.push({ line, error: Math.abs(elapsedS - expected) });
	}
	// One known candidate cannot be compared: whatever the rival's stopping
	// pattern is, the mirror has not got it, and "the only line I can score
	// fits" is not the same finding as "this line fits best".
	if (scored.length < 2) return null;
	scored.sort((x, y) => x.error - y.error);
	const [best, runnerUp] = scored;
	return runnerUp.error - best.error >= elapsedS * MIN_SEPARATION_FRACTION ? best.line : null;
}
