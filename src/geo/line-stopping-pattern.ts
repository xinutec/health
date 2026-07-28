/**
 * How many stations does a line actually CALL AT between two stops?
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
 * MEASURED 2026-07-28: the hop count below is right and discriminates
 * (Wembley Park → Finchley Road is 1 hop on the Metropolitan and 6 on the
 * Jubilee), but turning it into a DURATION prediction does not work, and the
 * duration comparison that used to live here has been removed rather than left
 * to mislead. Two reasons, both measured on 06-23:
 *
 *   - The segment window is not the ride. Its 631 s is ~150 s of platform wait
 *     plus 413 s moving plus ~90 s of arrival; the train itself averaged
 *     61.5 km/h over 7.06 km, an express, while the window reads 40 km/h.
 *   - No per-hop constant fits both fragments of one ride: the same day's
 *     confidently-Metropolitan Finchley Road → Euston Square leg spends 20.8
 *     min on ~3 hops.
 *
 * What the fix stream DOES show is the stopping pattern directly — 06-23's
 * interior is six unbroken minutes at 60–95 km/h with not one dwell, where an
 * all-stops Jubilee would show five. Counting interior dwells against this hop
 * count is the open work (#382); the hop count is the half that is already
 * right.
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
