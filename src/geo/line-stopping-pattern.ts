/**
 * Which of two lines sharing a track did the train run on? Ask where it STOPPED.
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
 * and Kilburn; the Jubilee calls at all of them. Same rails, same fixes,
 * completely different behaviour — and the behaviour is in the fix stream. The
 * stop lists needed to read it are mirrored in `rail_stops_cache` — ordered
 * `stop`-role relation members, the stations a service actually calls at, which
 * is exactly what proximity membership (`stationsOnLine`) structurally cannot
 * express (it counts Dollis Hill as "on" the Metropolitan because the fast
 * tracks pass within 300 m).
 *
 *     2026-06-23, Wembley Park → Finchley Road, 32 fixes at ~15 s:
 *       07:42:28-07:44:20  1.1, 0.6, 0.8, 0.9, 3.4 km/h      platform wait
 *       07:44:50-07:51:29  18.7 then 52-76 km/h unbroken, one 64 s gap
 *       07:52:31-07:52:59  0.0, 0.0, 0.0 km/h                arrived
 *
 *     The Metropolitan calls at 0 stations in between; the Jubilee calls at 5.
 *     Five stops cannot fit in what was observed. The ride was the Metropolitan.
 *
 * The question is asked as a POSSIBILITY, not a fit. Counting the pauses the
 * train visibly made gives a lower bound on its stops; asking how many more
 * could have hidden in the stretches nobody observed gives an upper bound. A
 * candidate survives when its true intermediate-stop count falls between them
 * — "not definitely impossible" — and a line is named only when exactly one
 * candidate survives. Two consequences worth stating: the model never has to
 * decide how well a ride "fits" a service, and a dark ride excludes nobody, so
 * missing data yields silence rather than a confident guess.
 *
 * The hiding bound is kinematics, not a tuned constant. A train cannot call at
 * a station in less than the time to brake from the speed it was last seen at,
 * open and close its doors, and regain the speed it was next seen at — so a
 * gap of Δt seconds between fixes at v₁ and v₂ can hide at most
 * `Δt / (v₁/a + DWELL_MIN_S + v₂/a)` stops. Every constant in that expression
 * is deliberately biased towards permitting stops (a strong brake rate, the
 * shortest realistic dwell), because over-permitting costs a null and
 * under-permitting costs a wrong label.
 *
 * MEASURED 2026-07-28, and recorded so it is not retried: predicting the ride's
 * DURATION from the hop count does not work, for two independent reasons.
 *
 *   - The segment window is not the ride. 06-23's 631 s is ~150 s of platform
 *     wait plus 413 s moving plus ~90 s of arrival; the train itself averaged
 *     61.5 km/h over 7.06 km, an express, while the window reads 40 km/h.
 *   - No per-hop constant fits both fragments of one ride: the same day's
 *     confidently-Metropolitan Finchley Road → Euston Square leg spends 20.8
 *     min on ~3 hops.
 *
 * The stop count is robust where duration is not, because it measures the
 * TRAIN rather than the segment boundary.
 */

import { normalizeStationName } from "../hmm/served-stations.js";
import type { FilteredPoint } from "./kalman.js";
import type { RailStopRelation } from "./osm-rail-stops.js";
import { railRelationsForLine } from "./rail-stops-cache.js";

/** At or above this the train is unambiguously running between stations — well
 *  clear of a platform crawl, a reacquire wobble, or anything a pedestrian or
 *  a bus in traffic reaches. Used to find where the RUNNING part of the ride
 *  starts and ends; station stops are looked for inside that. */
const RUNNING_KMH = 25;

/** At or below this the train is standing. Not zero: a fix taken at a platform
 *  still carries Kalman residue from the deceleration that preceded it. */
const DWELL_KMH = 8;

/** Service brake / acceleration rate, m/s². Deliberately at the top of the
 *  realistic range for a metro service: a higher rate means a stop fits into a
 *  shorter gap, which permits MORE hidden stops. Over-permitting yields a null
 *  (no candidate excluded); under-permitting yields a wrong line label. */
const BRAKE_MS2 = 1.3;

/** Shortest station dwell worth calling a stop, seconds — doors open, doors
 *  close. Real Underground dwells run 20-45 s; the low end is taken for the
 *  same reason as `BRAKE_MS2`. */
const DWELL_MIN_S = 20;

const KMH_TO_MS = 1 / 3.6;

/** Where a station sits in a relation's ordered stop list, or -1. */
function indexOfStop(rel: RailStopRelation, station: string): number {
	const target = normalizeStationName(station);
	return rel.stops.findIndex((s) => s.name !== null && normalizeStationName(s.name) === target);
}

/**
 * How many stations this line calls at BETWEEN the two named ones — 0 for a
 * non-stop hop — or null when the mirror cannot say (no relation for the line,
 * or none that stops at both endpoints).
 *
 * A relation is ONE direction of a service, so the endpoints may appear in
 * either order; the hop count is the absolute distance between them. Where a
 * line has several relations (directions, service variants) the FEWEST hops
 * wins: a semi-fast variant that skips stations is still that line, and the
 * question being asked is what the observed train could have been.
 */
export function intermediateStopCount(
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
	return fewestHops === null ? null : fewestHops - 1;
}

/** How many station stops could fit unseen in a `gapS`-second stretch between
 *  fixes at `fromKmh` and `toKmh` — brake, dwell, regain speed, repeat. */
function stopsThatFit(gapS: number, fromKmh: number, toKmh: number): number {
	const perStopS = (fromKmh * KMH_TO_MS) / BRAKE_MS2 + DWELL_MIN_S + (toKmh * KMH_TO_MS) / BRAKE_MS2;
	return Math.floor(gapS / perStopS);
}

/** The range of intermediate station stops the ride's fix stream allows. */
export interface StopBounds {
	/** Pauses actually observed between the first and last running fix. */
	atLeast: number;
	/** …plus every stop that could have hidden where nobody was looking. */
	atMost: number;
}

/**
 * How many times the train could have stood still between pulling away and
 * arriving, given what was observed — or null when it was never seen running,
 * which leaves nothing to bound.
 *
 * The interior is delimited by the train's own motion rather than by a guard
 * band on the clock: it runs from the first fix at running speed to the last,
 * which excludes the platform wait at the near end and the deceleration at the
 * far end without having to guess how long either was. A pause inside that
 * span has the train running on both sides of it, which is what makes it a
 * station stop rather than an endpoint.
 *
 * Unobserved time is treated the same wherever it falls, including before the
 * first running fix and after the last: a stretch nobody watched might hold a
 * stop, and the head of a ride whose GPS only came back halfway is exactly
 * such a stretch. That is what keeps a sparse ride from masquerading as a
 * confidently non-stop one — its `atMost` grows until it excludes nobody.
 */
export function stopBounds(points: readonly FilteredPoint[], boardTs: number, alightTs: number): StopBounds | null {
	const ride = points.filter((p) => p.ts >= boardTs && p.ts <= alightTs).sort((a, b) => a.ts - b.ts);
	const speed = (p: FilteredPoint) => p.speed_kmh ?? 0;
	const first = ride.findIndex((p) => speed(p) >= RUNNING_KMH);
	if (first < 0) return null;
	let last = ride.length - 1;
	while (speed(ride[last]) < RUNNING_KMH) last--;
	if (last === first) return null; // one running fix is a glimpse, not a ride

	// Observed pauses: maximal standing runs strictly inside the running span.
	let atLeast = 0;
	let standing = false;
	for (const p of ride.slice(first, last + 1)) {
		const isStanding = speed(p) <= DWELL_KMH;
		if (isStanding && !standing) atLeast++;
		standing = isStanding;
	}

	// Hidden capacity: what could have happened between consecutive fixes, and
	// in the two stretches the ride window extends past its first and last fix.
	// Counted over the WHOLE ride, not just the running span — a ride whose GPS
	// only came back halfway hides its early stops in exactly the stretch the
	// span excludes, and pretending otherwise would let sparse data pose as a
	// confidently non-stop ride.
	//
	// A pair with the train standing at BOTH ends contributes nothing: those two
	// observations bracket one pause, not a sequence of them, and crediting the
	// platform wait with four hidden stops is how this bound stops discriminating
	// anything. A pair with one end standing still counts — the standing end just
	// costs no braking or acceleration time.
	const hiddenBetween = (gapS: number, a: FilteredPoint, b: FilteredPoint) =>
		speed(a) <= DWELL_KMH && speed(b) <= DWELL_KMH ? 0 : stopsThatFit(gapS, speed(a), speed(b));
	let hidden = hiddenBetween(ride[0].ts - boardTs, ride[0], ride[0]);
	const lastFix = ride[ride.length - 1];
	hidden += hiddenBetween(alightTs - lastFix.ts, lastFix, lastFix);
	for (let i = 1; i < ride.length; i++) {
		hidden += hiddenBetween(ride[i].ts - ride[i - 1].ts, ride[i - 1], ride[i]);
	}
	return { atLeast, atMost: atLeast + hidden };
}

/**
 * Which candidate line's stopping pattern the ride does not rule out, or null
 * when it rules out fewer or more than exactly one.
 *
 * Deliberately willing to name a line on incomplete information — a ride that
 * demonstrably ran past four stations was not the service that calls at all
 * four, and saying so is worth more than the silence that leaves the journey
 * split in two. What it will not do is choose between candidates the ride
 * leaves both possible; that is a coin toss, and a coin toss belongs in the
 * caller's bare station-pair label, not in a line name.
 */
export function pickLineByStoppingPattern(
	candidates: readonly string[],
	board: string,
	alight: string,
	relations: readonly RailStopRelation[],
	points: readonly FilteredPoint[],
	boardTs: number,
	alightTs: number,
): string | null {
	const bounds = stopBounds(points, boardTs, alightTs);
	if (bounds === null) return null;

	const scored = candidates.map((line) => ({ line, stops: intermediateStopCount(line, board, alight, relations) }));
	// A candidate the mirror has no stop list for is not ruled out by anything
	// — it is simply unmeasured, and an unmeasured rival means the survivor
	// below would be an artefact of missing data rather than of the ride.
	if (scored.some((c) => c.stops === null)) return null;
	const possible = scored.filter((c) => c.stops !== null && c.stops >= bounds.atLeast && c.stops <= bounds.atMost);
	return possible.length === 1 ? possible[0].line : null;
}
