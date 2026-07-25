/**
 * V8 reference values for `shedVehiclePedestrianEdges` (`src/geo/stay-split.ts`).
 *
 * The first of the seven `stay-split.ts` array passes to move to Lean. An
 * earlier roadmap note filed these as "array orchestration → shell"; under the
 * standing boundary (pure record/array work belongs in Lean) that is wrong, and
 * they sit in the middle of the velocity pass order, so the pipeline cannot fold
 * in Lean without them.
 *
 * What it decides: a `train` leg whose edge fixes are actually the walk to or
 * from the platform. Scanning inward from each end it finds the contiguous run
 * of pedestrian-paced steps and hands it to the neighbouring walk — but only on
 * FOUR independent signals (pace ≤ 9 km/h every step, ≥ 90 s sustained, ≥ 120 m
 * net, ≥ 60 spm cadence through it), and only if a real ride is left behind.
 *
 * Sequencing that the guards pin: TAIL runs before HEAD *within the same
 * iteration*, and HEAD re-reads `out[i]` — so on a leg shed at both ends the
 * head test sees the already-shortened `endTs`, and its
 * `MIN_REMAINING_RIDE_S` check is against that.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/shed-edges-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import { shedVehiclePedestrianEdges } from "../../src/geo/stay-split.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(4400)", north(4400));

const fx = (ts: number, metresNorth: number, speed_kmh: number): FilteredPoint =>
	({ ts, ...north(metresNorth), accuracy: 10, speed_kmh, bearing: 0 }) as FilteredPoint;

const seg = (o: Record<string, unknown>) =>
	({
		mode: "train",
		avgSpeed: 40,
		maxSpeed: 60,
		linearity: 0.9,
		pointCount: 5,
		wayName: "A → B · Victoria Line",
		place: "Somewhere",
		refinedReason: "inherited",
		...o,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;

/** Steps at 80 spm — comfortably over PEDESTRIAN_MIN_CADENCE_SPM (60). */
const walkingSteps = (from: number, to: number): { ts: number; steps: number }[] => {
	const out: { ts: number; steps: number }[] = [];
	for (let t = from; t < to; t += 60) out.push({ ts: t, steps: 80 });
	return out;
};

/**
 * The canonical TAIL shape: a ride from 1000 to 1200 (two 72 km/h steps), then
 * a pedestrian tail 1200→1600 at 3.6 km/h covering 400 m net. The backward scan
 * stops at the 1100→1200 vehicle step, so the boundary is 1200.
 */
const TAIL_FIXES: FilteredPoint[] = [
	fx(1000, 0, 70),
	fx(1100, 2000, 72),
	fx(1200, 4000, 71),
	fx(1300, 4100, 3.6),
	fx(1400, 4200, 3.7),
	fx(1500, 4300, 3.5),
	fx(1600, 4400, 3.6),
	// the following walk's own fixes
	fx(1700, 4500, 3.6),
	fx(1800, 4600, 3.4),
	fx(1900, 4700, 3.8),
];
const TAIL_SEGS = [seg({ startTs: 1000, endTs: 1600 }), seg({ mode: "walking", startTs: 1600, endTs: 2000 })];

/** The HEAD mirror: pedestrian 1000→1400, then a ride 1400→1800. */
const HEAD_FIXES: FilteredPoint[] = [
	fx(600, -300, 3.5),
	fx(800, -200, 3.6),
	fx(1000, 0, 3.6),
	fx(1100, 100, 3.6),
	fx(1200, 200, 3.7),
	fx(1300, 300, 3.5),
	fx(1400, 400, 3.6),
	fx(1500, 2400, 72),
	fx(1600, 4400, 71),
	fx(1800, 6400, 70),
];
const HEAD_SEGS = [seg({ mode: "walking", startTs: 500, endTs: 1000 }), seg({ startTs: 1000, endTs: 1800 })];

type Case = {
	segments?: ReturnType<typeof seg>[];
	points?: FilteredPoint[];
	steps?: { ts: number; steps: number }[];
};

const CASES: Record<string, Case> = {
	// The tail run is handed to the following walk; the ride keeps its head.
	tailShed: {},
	// The head run is handed to the preceding walk; the ride keeps its tail.
	headShed: { segments: HEAD_SEGS, points: HEAD_FIXES, steps: walkingSteps(600, 1500) },

	// --- the four evidence signals, one at a time ---
	// No step data at all: the pass is inert.
	noSteps: { steps: [] },
	// Cadence below PEDESTRIAN_MIN_CADENCE_SPM: body signal fails.
	cadenceTooLow: { steps: walkingSteps(1200, 1600).map((s) => ({ ...s, steps: 30 })) },
	// Cadence exactly at the bar (60 spm over the window) still qualifies.
	cadenceAtBar: { steps: walkingSteps(1200, 1600).map((s) => ({ ...s, steps: 60 })) },
	// The pedestrian run is too SHORT in time (< PEDESTRIAN_MIN_RUN_S).
	runTooBrief: {
		points: [fx(1000, 0, 70), fx(1100, 2000, 72), fx(1200, 4000, 71), fx(1280, 4200, 3.6), fx(1700, 4300, 3.6)],
		segments: [seg({ startTs: 1000, endTs: 1280 }), seg({ mode: "walking", startTs: 1280, endTs: 2000 })],
	},
	// The pedestrian run covers too little NET ground (< PEDESTRIAN_MIN_RUN_NET_M).
	runTooShortNet: {
		points: [
			fx(1000, 0, 70),
			fx(1100, 2000, 72),
			fx(1200, 4000, 71),
			fx(1300, 4030, 1),
			fx(1400, 4060, 1),
			fx(1500, 4090, 1),
			fx(1600, 4110, 1),
		],
	},
	// A step just OVER the pedestrian pace ceiling stops the scan earlier, so
	// the claimed run is only the last two fixes and fails the time bar.
	paceCeiling: {
		points: [
			fx(1000, 0, 70),
			fx(1100, 2000, 72),
			fx(1200, 4000, 71),
			fx(1300, 4100, 3.6),
			fx(1400, 4200, 3.6),
			fx(1500, 4460, 9.4), // 260 m / 100 s = 9.36 km/h — over the 9 ceiling
			fx(1600, 4560, 3.6),
		],
	},

	// --- structural gates ---
	// Under MIN_REMAINING_RIDE_S of ride would be left: refuse.
	remainingRideTooShort: { segments: [seg({ startTs: 1100, endTs: 1600 }), TAIL_SEGS[1]] },
	// Exactly at MIN_REMAINING_RIDE_S (1200 - 1080 = 120): allowed.
	remainingRideAtBar: { segments: [seg({ startTs: 1080, endTs: 1600 }), TAIL_SEGS[1]] },
	// Every step is pedestrian-paced, so the scan runs to s === 0 — no ride to
	// keep, and the pass refuses rather than eating the whole leg.
	allPedestrian: {
		points: [fx(1000, 0, 3.6), fx(1200, 200, 3.6), fx(1400, 400, 3.6), fx(1600, 600, 3.6)],
	},
	// No pedestrian tail at all: the scan never moves, s === len-1.
	noPedestrianTail: {
		points: [fx(1000, 0, 70), fx(1200, 4000, 72), fx(1400, 8000, 71), fx(1600, 12000, 70)],
	},
	// The neighbour is not a walk, so there is nobody to hand the run to.
	neighbourNotWalking: { segments: [TAIL_SEGS[0], seg({ mode: "stationary", startTs: 1600, endTs: 2000 })] },
	// A non-train host is skipped entirely.
	hostNotTrain: { segments: [seg({ mode: "driving", startTs: 1000, endTs: 1600 }), TAIL_SEGS[1]] },
	// refinedMode wins over mode — `segMode` is `refinedMode ?? mode`.
	refinedModeIsTheHost: {
		segments: [seg({ mode: "driving", refinedMode: "train", startTs: 1000, endTs: 1600 }), TAIL_SEGS[1]],
	},
	// A walk identified only by refinedMode still receives the run.
	refinedModeNeighbour: {
		segments: [TAIL_SEGS[0], seg({ mode: "stationary", refinedMode: "walking", startTs: 1600, endTs: 2000 })],
	},

	// BOTH ends shed on one leg, in one iteration. The head test re-reads the
	// already-shortened endTs, so its remaining-ride check is against 1200.
	bothEndsShed: {
		segments: [
			seg({ mode: "walking", startTs: 500, endTs: 1000 }),
			seg({ startTs: 1000, endTs: 1800 }),
			seg({ mode: "walking", startTs: 1800, endTs: 2200 }),
		],
		points: [
			fx(600, -300, 3.5),
			fx(800, -200, 3.6),
			fx(1000, 0, 3.6),
			fx(1100, 100, 3.6),
			fx(1200, 200, 3.6), // head run ends here (next step is vehicle-paced)
			fx(1300, 2200, 72),
			fx(1400, 4200, 71),
			fx(1500, 4300, 3.6), // tail run starts here
			fx(1600, 4400, 3.6),
			fx(1700, 4500, 3.6),
			fx(1800, 4600, 3.6),
			fx(1900, 4700, 3.6),
		],
		steps: walkingSteps(600, 1900),
	},
	// --- gaps the first probe pass exposed ---
	// Cadence EXACTLY at the bar. The window is 400 s, so the mean is
	// total / (400/60); 400 steps over the seven buckets gives exactly 60.
	cadenceExactlyAtBar: {
		steps: [1200, 1260, 1320, 1380, 1440, 1500, 1560].map((ts, i) => ({ ts, steps: i === 6 ? 58 : 57 })),
	},
	// Steps exist but NONE overlap the run window: `meanCadenceSpm` returns
	// null, which is "no data", not "zero cadence" — and no data refuses.
	stepsOutsideWindow: { steps: walkingSteps(100, 400) },
	// The run lasts EXACTLY PEDESTRIAN_MIN_RUN_S (1200→1290 = 90 s).
	durExactlyAtBar: {
		points: [fx(1000, 0, 70), fx(1100, 2000, 72), fx(1200, 4000, 71), fx(1290, 4130, 5.2), fx(1700, 4200, 3.6)],
		segments: [seg({ startTs: 1000, endTs: 1290 }), seg({ mode: "walking", startTs: 1290, endTs: 2000 })],
		steps: walkingSteps(1200, 1290),
	},
	// Every step pedestrian-paced AND the cadence passes: the scan reaches
	// s === 0, and only the `s > 0` guard stops the whole leg being eaten.
	allPedestrianWithCadence: {
		points: [fx(1000, 0, 3.6), fx(1200, 200, 3.6), fx(1400, 400, 3.6), fx(1600, 600, 3.6)],
		steps: walkingSteps(1000, 1600),
	},
	// Head side, neighbour is not a walk: nobody to hand the run to.
	headPrevNotWalking: {
		segments: [seg({ mode: "stationary", startTs: 500, endTs: 1000 }), seg({ startTs: 1000, endTs: 1800 })],
		points: HEAD_FIXES,
		steps: walkingSteps(600, 1500),
	},
	// Head side with EXACTLY MIN_REMAINING_RIDE_S left (1520 − 1400 = 120).
	headRemainingAtBar: {
		segments: [seg({ mode: "walking", startTs: 500, endTs: 1000 }), seg({ startTs: 1000, endTs: 1520 })],
		points: HEAD_FIXES,
		steps: walkingSteps(600, 1500),
	},
	// The rebuilt walk's avgSpeed is a MEDIAN, not a mean: one 40 km/h outlier
	// among six pedestrian readings must not drag it up.
	medianNotMean: {
		points: [
			fx(1000, 0, 70),
			fx(1100, 2000, 72),
			fx(1200, 4000, 71),
			fx(1300, 4100, 3.6),
			fx(1400, 4200, 3.6),
			fx(1500, 4300, 3.6),
			fx(1600, 4400, 3.6),
			fx(1700, 4500, 3.6),
			fx(1800, 4600, 3.6),
			fx(1900, 4700, 40),
		],
	},
	// The walk remainder gets exactly ONE fix, so the `>= 2` guard leaves the
	// parent's kinematics in place rather than recomputing from a single point.
	singleFixRemainder: {
		segments: [seg({ mode: "walking", startTs: 990, endTs: 1000 }), seg({ startTs: 1000, endTs: 1800 })],
		points: [fx(950, -50, 3.6), fx(1000, 0, 3.6), fx(1200, 200, 3.6), fx(1300, 2200, 72), fx(1400, 4200, 71)],
		steps: walkingSteps(950, 1300),
	},
	// The fix sitting EXACTLY on the host's endTs is load-bearing: without it
	// the run falls under the net-distance bar. Pins the inclusive window.
	endTsFixIsLoadBearing: {
		points: [
			fx(1000, 0, 70),
			fx(1100, 2000, 72),
			fx(1200, 4000, 71),
			fx(1300, 4050, 1.8),
			fx(1400, 4100, 1.8),
			fx(1500, 4110, 0.4),
			fx(1600, 4200, 3.2),
		],
	},
	// The `s > 0` guard, ISOLATED. In `allPedestrianWithCadence` the scan
	// reaching 0 is also refused by MIN_REMAINING_RIDE_S (the boundary lands on
	// the segment's own start), so that case cannot pin it. Here the first fix
	// sits 150 s into the leg, so dropping `s > 0` WOULD shed — and eat the
	// whole ride.
	scanReachesZeroWithRideLeft: {
		segments: [seg({ startTs: 1000, endTs: 1600 }), seg({ mode: "walking", startTs: 1600, endTs: 2000 })],
		points: [fx(1150, 0, 4.8), fx(1300, 200, 4.8), fx(1450, 400, 4.8), fx(1600, 600, 4.8)],
		steps: walkingSteps(1150, 1600),
	},
	empty: { segments: [], points: [], steps: [] },
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
		};
	});

for (const [name, c] of Object.entries(CASES)) {
	const r = shedVehiclePedestrianEdges(
		c.segments ?? TAIL_SEGS,
		c.points ?? TAIL_FIXES,
		c.steps ?? walkingSteps(1200, 1600),
	);
	show(`shed.${name}`, view(r));
}
