/**
 * V8 reference values for `reassignWalkTailToVehicle` (`src/geo/stay-split.ts`).
 *
 * Moves a walking segment's vehicle-paced TRAILING run into the road-vehicle
 * segment that follows, by advancing the shared boundary. Segment count is
 * unchanged — only the boundary and the two segments' recomputed stats move.
 *
 * Three things here are easy to get wrong and are each pinned below:
 *
 *  1. `HANDOFF_VEHICLE_MODES` is `driving | bus | cycling` — a FOURTH
 *     vehicle-mode set in this repo. It INCLUDES bus (unlike
 *     `SegmentPasses.VEHICLE_MODES`) and EXCLUDES train and plane.
 *  2. The walk side is tested on the RAW `mode`, the vehicle side on
 *     `segMode` (= `refinedMode ?? mode`). Asymmetric, and observable.
 *  3. `stepKmh` returns 0 for a non-advancing pair, where the sibling pass
 *     `shedVehiclePedestrianEdges` returns +Infinity for the same shape. Each
 *     fails safe in its own direction: 0 can never be vehicle-paced, Infinity
 *     can never be pedestrian-paced.
 *
 * And two different windows appear in one function: the fix scan uses
 * `samplesInWindow` (INCLUSIVE both ends) while the `stats` recompute is
 * half-open `[start, end)`.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/walk-tail-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import { reassignWalkTailToVehicle } from "../../src/geo/stay-split.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(2400)", north(2400));

const fx = (ts: number, metresNorth: number, speed_kmh: number): FilteredPoint =>
	({ ts, ...north(metresNorth), accuracy: 10, speed_kmh, bearing: 0 }) as FilteredPoint;

const seg = (o: Record<string, unknown>) =>
	({
		mode: "walking",
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.5,
		pointCount: 7,
		refinedReason: "inherited",
		...o,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;

/** Walk 1000–1200 at ~1.8 km/h, then a vehicle-paced run to 1600. */
const FIXES: FilteredPoint[] = [
	fx(1000, 0, 3),
	fx(1100, 50, 3),
	fx(1200, 100, 4),
	fx(1300, 600, 22),
	fx(1400, 1200, 24),
	fx(1500, 1800, 23),
	fx(1600, 2400, 25),
	// the vehicle's own fixes
	fx(1700, 3000, 26),
	fx(1800, 3600, 27),
	fx(1900, 4200, 28),
];
const SEGS = [seg({ startTs: 1000, endTs: 1600 }), seg({ mode: "driving", startTs: 1600, endTs: 2000 })];

type Case = { segments?: ReturnType<typeof seg>[]; points?: FilteredPoint[] };

const CASES: Record<string, Case> = {
	// The boundary advances to 1200; both segments' stats are recomputed and
	// the vehicle gains a refinedReason naming the evidence.
	moved: {},

	// --- HANDOFF_VEHICLE_MODES, member by member ---
	nextBus: { segments: [SEGS[0], seg({ mode: "bus", startTs: 1600, endTs: 2000 })] },
	nextCycling: { segments: [SEGS[0], seg({ mode: "cycling", startTs: 1600, endTs: 2000 })] },
	// train and plane are NOT in this set, unlike other vehicle-mode constants.
	nextTrain: { segments: [SEGS[0], seg({ mode: "train", startTs: 1600, endTs: 2000 })] },
	nextPlane: { segments: [SEGS[0], seg({ mode: "plane", startTs: 1600, endTs: 2000 })] },
	nextWalking: { segments: [SEGS[0], seg({ mode: "walking", startTs: 1600, endTs: 2000 })] },
	// The vehicle side reads segMode, so a refinedMode promotion counts...
	nextRefinedToDriving: {
		segments: [SEGS[0], seg({ mode: "stationary", refinedMode: "driving", startTs: 1600, endTs: 2000 })],
	},
	// ...while the WALK side reads the RAW mode, so a refinedMode-only walk
	// is not a walk here.
	curRefinedToWalking: {
		segments: [seg({ mode: "stationary", refinedMode: "walking", startTs: 1000, endTs: 1600 }), SEGS[1]],
	},
	// No successor at all.
	noSuccessor: { segments: [SEGS[0]] },

	// --- the gates ---
	// Fewer than three fixes in the walk.
	tooFewFixes: { points: [fx(1000, 0, 3), fx(1600, 2400, 25), fx(1700, 3000, 26)] },
	// Only ONE vehicle-paced step: under HANDOFF_MIN_TAIL_STEPS.
	oneTailStep: {
		points: [fx(1000, 0, 3), fx(1100, 50, 3), fx(1200, 100, 4), fx(1300, 150, 4), fx(1600, 2400, 25), fx(1700, 3000, 26)],
	},
	// EXACTLY two vehicle-paced steps: at the bar, so it moves.
	twoTailSteps: {
		points: [
			fx(1000, 0, 3),
			fx(1100, 50, 3),
			fx(1200, 100, 4),
			fx(1300, 150, 4),
			fx(1400, 800, 22),
			fx(1600, 2400, 25),
			fx(1700, 3000, 26),
		],
	},
	// The run's NET displacement is under HANDOFF_MIN_NET_DIST_M.
	netTooShort: {
		points: [
			fx(1000, 0, 3),
			fx(1100, 50, 3),
			fx(1200, 100, 4),
			fx(1210, 150, 22),
			fx(1220, 175, 24),
			fx(1230, 160, 25),
			fx(1600, 170, 26),
		],
	},
	// No fix in the run reaches HANDOFF_PEAK_KMH: the second signal fails.
	peakTooLow: {
		points: [
			fx(1000, 0, 3),
			fx(1100, 50, 3),
			fx(1200, 100, 4),
			fx(1300, 600, 19),
			fx(1400, 1200, 19),
			fx(1500, 1800, 19),
			fx(1600, 2400, 19),
		],
	},
	// A peak of EXACTLY HANDOFF_PEAK_KMH clears it (`<` refuses below only).
	peakAtBar: {
		points: [
			fx(1000, 0, 3),
			fx(1100, 50, 3),
			fx(1200, 100, 4),
			fx(1300, 600, 20),
			fx(1400, 1200, 19),
			fx(1500, 1800, 19),
			fx(1600, 2400, 19),
		],
	},
	// The run would leave under HANDOFF_MIN_WALK_REMAINDER_S of walk.
	walkRemainderTooShort: { segments: [seg({ startTs: 1150, endTs: 1600 }), SEGS[1]] },
	// Exactly at the bar (1200 − 1140 = 60): allowed.
	walkRemainderAtBar: { segments: [seg({ startTs: 1140, endTs: 1600 }), SEGS[1]] },

	// A non-advancing pair: `stepKmh` returns 0, which can never be
	// vehicle-paced, so the scan stops there rather than running through.
	// The scan must actually REACH the zero-dt pair: every step after it is
	// vehicle-paced, so only `stepKmh`'s 0 stops the walk-back. Were it
	// +Infinity (as in the sibling `shedVehiclePedestrianEdges`) the scan would
	// run on to 1200 and the boundary WOULD move.
	zeroDtPair: {
		points: [
			fx(1000, 0, 3),
			fx(1100, 50, 3),
			fx(1200, 100, 4),
			fx(1300, 600, 22),
			fx(1400, 1200, 24),
			fx(1400, 1800, 23), // same ts as the previous fix
			fx(1500, 2400, 25),
		],
	},
	// HANDOFF_MOVE_KMH's VALUE, isolated. The 1200→1300 step runs at 12 km/h —
	// above walking, below the 15 km/h vehicle floor. At 15 the walk-back stops
	// there (boundary 1300); lower the floor to 10 and it continues to 1200.
	stepBetweenWalkAndVehiclePace: {
		points: [
			fx(1000, 0, 3),
			fx(1100, 50, 3),
			fx(1200, 100, 4),
			fx(1300, 433, 12),
			fx(1400, 1033, 22),
			fx(1500, 1633, 23),
			fx(1600, 2233, 25),
		],
	},
	// HANDOFF_MIN_NET_DIST_M's VALUE, isolated. Two short vehicle-paced steps
	// cover ~300 m net: over the 80 m floor, but a floor of 500 would refuse.
	netJustOverBar: {
		points: [fx(1000, 0, 3), fx(1100, 50, 3), fx(1200, 100, 4), fx(1220, 250, 27), fx(1240, 400, 28)],
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
			pointCount: x.pointCount ?? null,
			avgSpeed: x.avgSpeed ?? null,
			maxSpeed: x.maxSpeed ?? null,
			refinedReason: x.refinedReason ?? null,
		};
	});

for (const [name, c] of Object.entries(CASES)) {
	const r = reassignWalkTailToVehicle(c.segments ?? SEGS, c.points ?? FIXES);
	show(`tail.${name}`, view(r));
}
