/**
 * V8 reference values for `splitWalksOnVehicleLeg` (`src/geo/stay-split.ts`).
 *
 * The only stay-split pass that GROWS the segment list: a walk hiding a ride
 * becomes `[walk?, driving, walk?]`. It searches every contiguous fix interval
 * (O(n²), n tiny) for the one that best looks like a ride, trims on-foot
 * shoulders off it, then refuses outright if the carve would butt against an
 * adjacent train — the boarding/alighting bleed guard.
 *
 * Three details the guards pin:
 *
 *  1. The gate is the EFFECTIVE mode. A short urban car ride averages low, so
 *     the raw `mode` is often "walking" while OSM refinement has already
 *     called it `driving`. Gating on the raw mode made this pass carve a
 *     confirmed 14-minute car ride into a walk plus a 3-minute drive
 *     (2026-05-25, Fulton Road).
 *  2. Interval choice: most ground wins; on an exact tie the SHORTER duration
 *     wins, so flat departure fixes don't pad the leg outward.
 *  3. `pointCount` uses an INCLUSIVE `[driveStart, driveEnd]` window — a third
 *     convention in this one file (`samplesInWindow` is inclusive, the `stats`
 *     recompute is half-open). Deliberate: the boundary fixes are the ride's,
 *     so the walks either side must not also count them.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/vehicle-leg-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import { splitWalksOnVehicleLeg } from "../../src/geo/stay-split.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(3000)", north(3000));

const fx = (ts: number, metresNorth: number, speed_kmh: number): FilteredPoint =>
	({ ts, ...north(metresNorth), accuracy: 10, speed_kmh, bearing: 0 }) as FilteredPoint;

const seg = (o: Record<string, unknown>) =>
	({
		mode: "walking",
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.5,
		pointCount: 9,
		wayName: "Some Footway",
		place: "Somewhere",
		...o,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;

/** A 20-minute "walk" with a ride buried in the middle: on foot 1000–1300,
 *  a 2 km ride 1300–1600, on foot again to 2200. */
const FIXES: FilteredPoint[] = [
	fx(1000, 0, 4),
	fx(1150, 100, 4),
	fx(1300, 200, 5),
	fx(1450, 1200, 45),
	fx(1600, 2200, 42),
	fx(1750, 2300, 5),
	fx(1900, 2400, 4),
	fx(2050, 2500, 4),
	fx(2200, 2600, 4),
];
const SEGS = [seg({ startTs: 1000, endTs: 2200 })];

type Case = { segments?: ReturnType<typeof seg>[]; points?: FilteredPoint[] };

const CASES: Record<string, Case> = {
	// walk / driving / walk — the list GROWS from 1 to 3.
	carved: {},

	// --- the gate ---
	// The EFFECTIVE mode decides: a leg OSM already called driving is the ride,
	// not a walk hiding one. Gating on raw `mode` here was a real bug.
	refinedToDriving: { segments: [seg({ startTs: 1000, endTs: 2200, refinedMode: "driving" })] },
	// A refinedMode-only walk IS eligible.
	refinedToWalking: {
		segments: [seg({ startTs: 1000, endTs: 2200, mode: "stationary", refinedMode: "walking" })],
	},
	// Under VEHICLE_LEG_MIN_SEGMENT_S (5 min) the pass does not look.
	// Under the bar the pass does not look — the window must otherwise CONTAIN
	// a qualifying ride, or lowering the constant changes nothing.
	segmentTooShort: {
		segments: [seg({ startTs: 1000, endTs: 1290 })],
		points: [fx(1000, 0, 45), fx(1150, 1000, 45), fx(1290, 2000, 42)],
	},
	// Exactly at the bar (300 s) the pass DOES look — and finds a ride. A
	// window that merely fails to contain one cannot pin the constant.
	segmentAtBar: {
		segments: [seg({ startTs: 1000, endTs: 1300 })],
		points: [fx(1000, 0, 45), fx(1150, 1000, 45), fx(1300, 2000, 42)],
	},
	tooFewFixes: { points: [fx(1000, 0, 4), fx(1600, 2200, 42)] },

	// --- the interval gates ---
	// Net distance under VEHICLE_LEG_MIN_DIST_M (400 m).
	distTooShort: {
		points: [fx(1000, 0, 4), fx(1150, 100, 4), fx(1300, 200, 5), fx(1450, 500, 45), fx(1600, 550, 42), fx(2200, 600, 4)],
	},
	// Every candidate interval fails a gate: the fast pair is under
	// VEHICLE_LEG_MIN_DURATION_S, the long pairs are too slow or too short.
	durTooShort: { points: [fx(1000, 0, 4), fx(1100, 2000, 45), fx(2200, 2050, 4)] },
	// SHOULDER TRIMMING CAN SHRINK THE LEG BELOW THE SEARCH MINIMUM. The
	// interval that wins the search spans 250 s, but trimming the slow leading
	// shoulder leaves a 100 s ride — under VEHICLE_LEG_MIN_DURATION_S, and kept.
	// Note the artefact: avgSpeed (net/dur) exceeds maxSpeed (a speed reading).
	trimBelowMinDuration: {
		points: [fx(1000, 0, 4), fx(1150, 100, 4), fx(1300, 200, 5), fx(1400, 2200, 45), fx(2200, 2300, 4)],
	},
	// Mean pace under VEHICLE_LEG_MOVE_KMH (15 km/h) — a long slow trudge that
	// covers the distance but not at vehicle pace.
	meanTooSlow: {
		points: [
			fx(1000, 0, 4),
			fx(1300, 200, 5),
			fx(1600, 600, 8),
			fx(1900, 1000, 8),
			fx(2200, 1400, 8),
		],
	},
	// No fix reaches VEHICLE_LEG_PEAK_KMH (20) — station jitter, not a ride.
	peakTooLow: {
		points: [fx(1000, 0, 4), fx(1150, 100, 4), fx(1300, 200, 5), fx(1450, 1200, 19), fx(1600, 2200, 19), fx(2200, 2300, 4)],
	},

	// --- shoulder trimming + remainders ---
	// The ride reaches the segment's start, so there is no leading walk.
	rideAtSegmentStart: {
		points: [fx(1000, 0, 45), fx(1150, 1000, 45), fx(1300, 2000, 42), fx(1450, 2100, 5), fx(1600, 2200, 4), fx(2200, 2300, 4)],
	},
	// A sub-minute leading residual is folded into the ride.
	shortLeadingResidual: {
		points: [fx(1000, 0, 4), fx(1050, 50, 45), fx(1200, 1050, 45), fx(1400, 2200, 42), fx(1600, 2300, 5), fx(2200, 2400, 4)],
	},

	// --- the train-bleed guards ---
	// A carve butting against the FOLLOWING train is boarding bleed, not a ride.
	bleedIntoNextTrain: {
		segments: [seg({ startTs: 1000, endTs: 2200 }), seg({ mode: "train", startTs: 2200, endTs: 3000 })],
		points: [fx(1000, 0, 4), fx(1300, 200, 5), fx(1880, 2200, 45), fx(2130, 3300, 42), fx(2200, 3350, 40)],
	},
	// …and against the PRECEDING train is alighting bleed.
	bleedFromPrevTrain: {
		segments: [seg({ mode: "train", startTs: 200, endTs: 1000 }), seg({ startTs: 1000, endTs: 2200 })],
		points: [fx(1000, 0, 40), fx(1050, 800, 45), fx(1300, 2000, 42), fx(1600, 2100, 5), fx(2200, 2200, 4)],
	},
	// A train neighbour that the carve does NOT butt against is fine.
	trainNeighbourNoBleed: {
		segments: [seg({ startTs: 1000, endTs: 2200 }), seg({ mode: "train", startTs: 2200, endTs: 3000 })],
	},
	// The bleed test reads the EFFECTIVE mode of the neighbour too.
	bleedRefinedTrain: {
		segments: [
			seg({ startTs: 1000, endTs: 2200 }),
			seg({ mode: "stationary", refinedMode: "train", startTs: 2200, endTs: 3000 }),
		],
		points: [fx(1000, 0, 4), fx(1300, 200, 5), fx(1880, 2200, 45), fx(2130, 3300, 42), fx(2200, 3350, 40)],
	},
	// AN EXACT netDist TIE between two intervals sharing a start fix and ending
	// at IDENTICAL coordinates. The tighter (shorter) one must win, so flat
	// arrival fixes cannot pad the leg outward.
	// The two tied intervals must SURVIVE shoulder trimming, or the trim undoes
	// the tie-break and the case pins nothing (my first attempt did exactly
	// that). +1500 m and −1500 m from the start fix are exactly equidistant, and
	// the step between them is vehicle-paced, so neither end trims.
	exactDistanceTie: {
		points: [fx(1000, 0, 45), fx(1250, 1500, 45), fx(1300, -1500, 45), fx(2200, -1450, 4)],
	},
	empty: { segments: [], points: [] },
};

const view = (segs: unknown[]) =>
	segs.map((s) => {
		const x = s as Record<string, unknown>;
		return {
			startTs: x.startTs,
			endTs: x.endTs,
			mode: x.mode,
			refinedMode: x.refinedMode ?? null,
			pointCount: x.pointCount ?? null,
			avgSpeed: x.avgSpeed ?? null,
			maxSpeed: x.maxSpeed ?? null,
			linearity: x.linearity ?? null,
			wayName: x.wayName ?? null,
			place: x.place ?? null,
			needsReenrich: x.needsReenrich ?? null,
			refinedReason: x.refinedReason ?? null,
		};
	});

for (const [name, c] of Object.entries(CASES)) {
	const r = splitWalksOnVehicleLeg(c.segments ?? SEGS, c.points ?? FIXES);
	show(`veh.${name}`, view(r));
}
