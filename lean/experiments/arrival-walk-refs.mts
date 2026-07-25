/**
 * V8 reference values for `reassignVehicleArrivalWalk` (`src/geo/stay-split.ts`).
 *
 * The arrival-side mirror of `reassignWalkTailToVehicle`, but structurally
 * different in three ways that the guards pin:
 *
 *  1. `prev` is read from the OUTPUT array (`out[out.length - 1]`), not from
 *     the input — so it is whatever the previous iteration emitted.
 *  2. When it acts it REWRITES that output element and does NOT push `cur`,
 *     so the phantom walk is DROPPED and the segment count shrinks.
 *  3. `prev` is matched on `segMode`, `next` on the RAW `mode` — the opposite
 *     pairing to the departure-side pass.
 *
 * The precision gate is `tailParked`: three conjuncts (every residual fix
 * within 90 m of the stay centroid, net progress ≤ 45 m, median speed ≤ 2.5
 * km/h). If the residual WALKS — a real walk-in from the kerb — the pass must
 * leave the whole thing alone. Each conjunct gets its own case.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/arrival-walk-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import { reassignVehicleArrivalWalk } from "../../src/geo/stay-split.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(1200)", north(1200));

const fx = (ts: number, metresNorth: number, speed_kmh: number): FilteredPoint =>
	({ ts, ...north(metresNorth), accuracy: 10, speed_kmh, bearing: 0 }) as FilteredPoint;

const seg = (o: Record<string, unknown>) =>
	({ mode: "walking", avgSpeed: 4, maxSpeed: 6, linearity: 0.5, pointCount: 7, ...o }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** drive 500–1000, phantom walk 1000–1600, stay 1600–2200. */
const SEGS = [
	seg({ mode: "driving", startTs: 500, endTs: 1000, avgSpeed: 30, maxSpeed: 40 }),
	seg({ startTs: 1000, endTs: 1600 }),
	seg({ mode: "stationary", startTs: 1600, endTs: 2200 }),
];

/** A vehicle head 1000→1200, then parked within a few metres. */
const FIXES: FilteredPoint[] = [
	fx(500, -2000, 40),
	fx(700, -1000, 38),
	fx(900, -200, 30),
	fx(1000, 0, 25),
	fx(1100, 600, 22),
	fx(1200, 1200, 21),
	fx(1300, 1210, 1),
	fx(1400, 1215, 0.5),
	fx(1500, 1212, 0.4),
	fx(1600, 1214, 0.3),
	fx(1700, 1213, 0.2),
	fx(1800, 1215, 0.3),
	fx(1900, 1212, 0.1),
];

/** Replace the parked residual with a real walk-in from the kerb. */
const walkInTail = (medianKmh: number, spread: number): FilteredPoint[] => [
	...FIXES.slice(0, 6),
	fx(1300, 1200 + spread, medianKmh),
	fx(1400, 1200 + 2 * spread, medianKmh),
	fx(1500, 1200 + 3 * spread, medianKmh),
	fx(1600, 1200 + 4 * spread, medianKmh),
	fx(1700, 1200 + 4 * spread, 0.2),
	fx(1800, 1200 + 4 * spread, 0.3),
	fx(1900, 1200 + 4 * spread, 0.1),
];

type Case = { segments?: ReturnType<typeof seg>[]; points?: FilteredPoint[] };

const CASES: Record<string, Case> = {
	// The drive absorbs its arrival tail, the residual folds into the stay,
	// and the phantom walk is DROPPED — three segments become two.
	folded: {},

	// --- who may participate ---
	// prev is matched on segMode, so a refinedMode promotion counts.
	prevRefinedToDriving: {
		segments: [seg({ mode: "stationary", refinedMode: "driving", startTs: 500, endTs: 1000 }), SEGS[1], SEGS[2]],
	},
	// train is not in HANDOFF_VEHICLE_MODES.
	prevTrain: { segments: [seg({ mode: "train", startTs: 500, endTs: 1000 }), SEGS[1], SEGS[2]] },
	// next is matched on the RAW mode, so a refinedMode-only stay does NOT count.
	nextRefinedToStationary: {
		segments: [SEGS[0], SEGS[1], seg({ mode: "walking", refinedMode: "stationary", startTs: 1600, endTs: 2200 })],
	},
	nextNotStationary: { segments: [SEGS[0], SEGS[1], seg({ mode: "walking", startTs: 1600, endTs: 2200 })] },
	curNotWalking: { segments: [SEGS[0], seg({ mode: "driving", startTs: 1000, endTs: 1600 }), SEGS[2]] },
	// No predecessor at all: the walk is first.
	noPrev: { segments: [SEGS[1], SEGS[2]] },
	// No successor at all.
	noNext: { segments: [SEGS[0], SEGS[1]] },

	// --- the head gates ---
	tooFewFixes: {
		points: [fx(500, -2000, 40), fx(1000, 0, 25), fx(1200, 1200, 21), fx(1700, 1213, 0.2)],
	},
	// One vehicle-paced step only.
	oneHeadStep: {
		points: [...FIXES.slice(0, 4), fx(1100, 600, 22), fx(1200, 610, 1), ...FIXES.slice(6)],
	},
	// The head's NET displacement is under ARRIVAL_MIN_NET_DIST_M.
	headNetTooShort: {
		points: [
			...FIXES.slice(0, 4),
			fx(1010, 50, 22),
			fx(1020, 75, 21),
			fx(1300, 70, 1),
			fx(1400, 72, 0.5),
			fx(1500, 71, 0.4),
			fx(1600, 73, 0.3),
			fx(1700, 72, 0.2),
		],
	},
	// No fix in the head reaches ARRIVAL_PEAK_KMH.
	peakTooLow: {
		points: [fx(500, -2000, 40), fx(900, -200, 19), fx(1000, 0, 19), fx(1100, 600, 19), fx(1200, 1200, 19), ...FIXES.slice(6)],
	},

	// --- tailParked, one conjunct at a time ---
	// A residual fix outside ARRIVAL_STAY_RADIUS_M of the stay centroid.
	tailFixOutsideRadius: {
		points: [...FIXES.slice(0, 6), fx(1300, 1350, 1), ...FIXES.slice(7)],
	},
	// The residual's NET progress exceeds ARRIVAL_TAIL_MAX_NET_M.
	tailNetTooFar: { points: walkInTail(1, 15) },
	// The residual MOVES at walking pace — a real walk-in from the kerb. The
	// pass must leave the whole thing alone: better a mislabelled vehicle head
	// than an eaten walk.
	tailWalksIn: { points: walkInTail(4.5, 5) },

	// The stay has NO fixes of its own, so the centroid falls back to the
	// walk's LAST fix. Must stop BEFORE ts 1600 — `samplesInWindow` is
	// inclusive at both ends, so a fix AT the stay's startTs is already one of
	// its fixes and the fallback never fires.
	stayHasNoFixes: { points: FIXES.slice(0, 9) },
	// ARRIVAL_MOVE_KMH's VALUE, isolated: a 12 km/h step is above walking and
	// below the 15 km/h vehicle floor, so the head scan must stop there.
	stepBetweenWalkAndVehiclePace: {
		points: [
			fx(500, -2000, 40),
			fx(900, -200, 30),
			fx(1000, 0, 25),
			fx(1100, 600, 22),
			fx(1200, 1200, 21),
			fx(1300, 1533, 12),
			fx(1400, 1543, 1),
			fx(1500, 1540, 0.4),
			fx(1600, 1542, 0.3),
			fx(1700, 1541, 0.2),
		],
	},

	// prev already carries a reason: the new one is appended after "; ".
	prevHasReason: {
		segments: [
			seg({ mode: "driving", startTs: 500, endTs: 1000, refinedReason: "bus route 38" }),
			SEGS[1],
			SEGS[2],
		],
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
	const r = reassignVehicleArrivalWalk(c.segments ?? SEGS, c.points ?? FIXES);
	show(`arr.${name}`, view(r));
}
