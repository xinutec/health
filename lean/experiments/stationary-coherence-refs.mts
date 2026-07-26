/**
 * V8 reference values for the `stationaryCoherence` pass — one of the two pass
 * bodies written inline in `computeVelocityFromInputs` rather than in a module
 * of its own (`src/geo/velocity.ts`, the first entry in the pass list).
 *
 * The constraint: a segment the classifier called `stationary` but whose fixes
 * march in a directed line over real ground is slow LOCOMOTION — a walk to a
 * platform — not a stay. Low per-fix speed is what misread it.
 *
 * It runs FIRST, before merge and before place attribution, so a reclassified
 * walk (a) coalesces with the adjacent walk and (b) never gets named after a POI
 * it merely drifted past — the 2026-06-12 "Bleecker" / "The Other Palace"
 * phantoms.
 *
 * The subtlety is #354: the decision reads TWO displacements. The raw one is
 * first→last across the whole window; the CORE one severs the window at every
 * vehicle-paced step and measures only the largest pedestrian run. A ride's head
 * stranded in a long stay's tail shows a huge raw displacement, and without the
 * core figure it would flip hours of real dwelling into one giant walk.
 *
 * The harness drives the pass body directly — it is not exported — so the
 * expected values here are computed from the same leaves the TS composes
 * (`effectiveMode`, `samplesInWindow`, `haversineMeters`,
 * `pedestrianCoreDisplacementM`, `isStationaryIncoherent`), which is exactly
 * what the Lean twin does.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/stationary-coherence-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import { samplesInWindow } from "../../src/geo/segment-util.js";
import { isStationaryIncoherent, pedestrianCoreDisplacementM } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

// The pass's own haversine, copied from velocity.ts's import (segments.ts).
const haversineMeters = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const fx = (ts: number, metresNorth: number): FilteredPoint =>
	({ ts, lat: LAT0 + metresNorth * MLAT, lon: LON0, accuracy: 10, speed_kmh: 1, bearing: 0 }) as FilteredPoint;

type Seg = {
	startTs: number;
	endTs: number;
	mode: string;
	refinedMode?: string;
	linearity: number;
	place?: string;
};

/** The pass body, transcribed from velocity.ts (minus the STAY_FLIP_DEBUG arm). */
const stationaryCoherence = (segs: Seg[], points: FilteredPoint[]): unknown[] =>
	segs.map((seg) => {
		const effective = seg.refinedMode ?? seg.mode;
		if (effective !== "stationary") return seg;
		const segPoints = samplesInWindow(points, seg);
		if (segPoints.length < 2) return seg;
		const first = segPoints[0];
		const last = segPoints[segPoints.length - 1];
		const netDisplacementM = haversineMeters(first.lat, first.lon, last.lat, last.lon);
		const coreDisplacementM = pedestrianCoreDisplacementM(segPoints);
		const durationS = seg.endTs - seg.startTs;
		if (!isStationaryIncoherent({ linearity: seg.linearity, netDisplacementM, coreDisplacementM, durationS }))
			return seg;
		return {
			...seg,
			mode: "walking",
			refinedMode: "walking",
			refinedReason: `stationary-coherence override (linear ${netDisplacementM.toFixed(0)} m progress, lin ${seg.linearity.toFixed(2)} — moving, not a stay)`,
			place: undefined,
		};
	});

/** A directed 300 m march over 10 minutes: locomotion misread as a stay. */
const MARCH: FilteredPoint[] = Array.from({ length: 11 }, (_, k) => fx(60 * k, 30 * k));
/** Barely moving: 20 m of drift over the same window. */
const DRIFT: FilteredPoint[] = Array.from({ length: 11 }, (_, k) => fx(60 * k, 2 * k));

/** Hours of real dwelling, then a ride's head stranded in the tail (#354): the
 *  raw first→last displacement is kilometres, but the pedestrian core is a few
 *  metres of indoor jitter. */
const DWELL_WITH_RIDE_TAIL: FilteredPoint[] = [
	...Array.from({ length: 20 }, (_, k) => fx(600 * k, k % 2 === 0 ? 0 : 4)),
	fx(11700, 3000),
	fx(12000, 6000),
];

const seg = (o: Partial<Seg>): Seg => ({
	startTs: 0,
	endTs: 600,
	mode: "stationary",
	linearity: 0.9,
	place: "The Other Palace",
	...o,
});

const CASES: Record<string, { segs: Seg[]; points: FilteredPoint[] }> = {
	// A directed march the classifier called a stay: flipped to walking, and the
	// place label is DROPPED — it was never evidence about a walk.
	marchFlips: { segs: [seg({})], points: MARCH },
	// Barely-moving drift is left alone.
	driftHeld: { segs: [seg({})], points: DRIFT },
	// Low linearity: wandering, not marching.
	lowLinearity: { segs: [seg({ linearity: 0.3 })], points: MARCH },

	// WHO PARTICIPATES: the EFFECTIVE mode, so a refinement in either direction
	// counts — the opposite of the stay-split passes, which read the raw mode.
	notStationary: { segs: [seg({ mode: "walking" })], points: MARCH },
	refinedStationaryParticipates: {
		segs: [seg({ mode: "walking", refinedMode: "stationary" })],
		points: MARCH,
	},
	refinedWalkingExcluded: {
		segs: [seg({ mode: "stationary", refinedMode: "walking" })],
		points: MARCH,
	},

	// Fewer than two fixes in the window: nothing to measure.
	oneFix: { segs: [seg({ endTs: 30 })], points: MARCH },
	noFixes: { segs: [seg({ startTs: 20000, endTs: 20600 })], points: MARCH },

	// #354: the raw displacement is 6 km but the pedestrian core is 4 m, so the
	// hours of dwelling survive the ride head stranded in the tail.
	dwellWithRideTail: {
		segs: [seg({ startTs: 0, endTs: 13200, linearity: 0.95 })],
		points: DWELL_WITH_RIDE_TAIL,
	},

	// The window is a STRICT SUBSET of the fix array, and that is what is
	// measured: the first two minutes of the march cover 60 m, under the bar, so
	// this stay is held — where the whole 300 m array would have flipped it.
	windowSubset: { segs: [seg({ endTs: 120 })], points: MARCH },

	// The duration is the SEGMENT's, not the fixes' span. A 90-minute declared
	// stay whose only fixes are a 10-minute march at the start: 300 m of linear
	// progress, but spread over 90 minutes that is 0.2 km/h — dwelling with a
	// departure tail, not a walk. Measured over the fixes' own 10 minutes it
	// would fall under the dwell floor and flip.
	longStayShortMarch: { segs: [seg({ endTs: 5400 })], points: MARCH },

	empty: { segs: [], points: [] },
};

for (const [name, c] of Object.entries(CASES)) {
	show(`coh.${name}`, stationaryCoherence(c.segs, c.points));
}

// The two displacements the decision reads, printed for the marching case so
// the Lean twin pins the arithmetic and not just the verdict.
const m = samplesInWindow(MARCH, { startTs: 0, endTs: 600 });
show("march.net", haversineMeters(m[0].lat, m[0].lon, m[m.length - 1].lat, m[m.length - 1].lon));
show("march.core", pedestrianCoreDisplacementM(m));
const d = samplesInWindow(DWELL_WITH_RIDE_TAIL, { startTs: 0, endTs: 13200 });
show("dwellTail.net", haversineMeters(d[0].lat, d[0].lon, d[d.length - 1].lat, d[d.length - 1].lon));
show("dwellTail.core", pedestrianCoreDisplacementM(d));
