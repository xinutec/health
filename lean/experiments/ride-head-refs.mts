/**
 * V8 reference values for `claimRideHeadFromStay` (`src/geo/stay-split.ts`).
 *
 * The last stay-split pass, and the only one that deliberately INVENTS a
 * segment: GPS dies in the tunnel just after boarding, so segmentation sees no
 * boundary until the reacquire fixes cohere minutes into the ride. The stay
 * swallows the walk to the station, the platform wait, and the ride's head.
 * Nothing false is drawn (a stay renders as a dot) but the walk is missing and
 * the ride's start is a lie.
 *
 * Anatomy scanned from the dwell outward: march (contiguous moving run) →
 * optional wait (standing) → ride (a vehicle-paced step after which the fixes
 * never return to the dwell).
 *
 * The subtle part is the DWELL POSITION: a TIME-WEIGHTED, component-wise
 * median. Indoor GPS is sparse — a multi-hour dwell may be four fixes and a
 * long gap, while the departing tail is a dense fix-per-100 s run — so a plain
 * per-fix median lands in the TAIL. Weighting each fix by how long its position
 * held puts the dwell back in charge. The happy path below has 4 dwell fixes
 * against 10 tail fixes, so an unweighted median would sit ~200 m away and the
 * `MARCH_START_MAX_FROM_DWELL_M` gate would refuse the carve outright.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/ride-head-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import { claimRideHeadFromStay } from "../../src/geo/stay-split.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(4000)", north(4000));

const fx = (ts: number, metresNorth: number, speed_kmh: number): FilteredPoint =>
	({ ts, ...north(metresNorth), accuracy: 10, speed_kmh, bearing: 0 }) as FilteredPoint;

const seg = (o: Record<string, unknown>) =>
	({ mode: "stationary", avgSpeed: 0, maxSpeed: 1, linearity: 0.1, pointCount: 14, ...o }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SEGS = [seg({ startTs: 0, endTs: 4000 }), seg({ mode: "train", startTs: 4000, endTs: 6000 })];

/** Four sparse dwell fixes, a 300 s march, a standing wait, then the ride. */
const FIXES: FilteredPoint[] = [
	fx(0, 0, 0),
	fx(1000, 5, 0),
	fx(2000, 3, 0),
	fx(3000, 4, 0),
	fx(3100, 10, 3.6),
	fx(3200, 110, 3.6),
	fx(3300, 210, 3.6),
	fx(3400, 310, 3.6),
	fx(3500, 315, 0.2),
	fx(3600, 318, 0.1),
	fx(3700, 1000, 25),
	fx(3800, 2000, 30),
	fx(3900, 3000, 32),
	fx(4000, 4000, 34),
];

const stepsAt = (spm: number, from: number, to: number): { ts: number; steps: number }[] => {
	const out: { ts: number; steps: number }[] = [];
	for (let t = from; t < to; t += 60) out.push({ ts: t, steps: spm });
	return out;
};
const STEPS = stepsAt(80, 3100, 3400);

type Case = {
	segments?: ReturnType<typeof seg>[];
	points?: FilteredPoint[];
	steps?: { ts: number; steps: number }[];
};

/** Swap the march fixes for a variant, keeping dwell + wait + ride. */
const withMarch = (march: FilteredPoint[]): FilteredPoint[] => [
	...FIXES.slice(0, 4),
	...march,
	...FIXES.slice(8),
];

/* ---------------------------------------------------------------------------
 * SECOND PROBE PASS — fixtures for the eight choices the first pass left open.
 *
 * The recurring failure of the first pass was a case that refused for the WRONG
 * reason, so each of these must reach the gate under test with every OTHER gate
 * satisfied. The shared skeleton does that work: a dwell at the frame origin, a
 * long indoor gap (so the step INTO the march is slower than MARCH_STILL_KMH
 * and the backward scan stops there rather than running on into the dwell), a
 * pedestrian march, a standing wait, and a two-fix ride.
 *
 * That gap is the crux. A march that sets out from far away is reached by a
 * FAST step, which drags `w` back to the dwell fix and makes `fromDwell[w]`
 * zero — which is why the first pass could not pin the tether at all.
 * ------------------------------------------------------------------------- */

/** Dwell → 600 s gap → 200 m march → wait → ride, the march opening `startM`
 *  north of the dwell. `startM` moves nothing but `fromDwell[w]`. */
const farMarch = (startM: number): FilteredPoint[] => [
	fx(0, 0, 0),
	fx(1200, 0, 0),
	fx(1800, startM, 3.6),
	fx(1900, startM + 100, 3.6),
	fx(2000, startM + 200, 3.6),
	fx(2100, startM + 205, 0.2),
	fx(2200, startM + 1100, 30),
	fx(2300, startM + 2300, 34),
];
const FAR_SEGS = [seg({ startTs: 0, endTs: 2300 }), seg({ mode: "train", startTs: 2300, endTs: 4000 })];
const FAR_STEPS = stepsAt(80, 1800, 2000);

/** The same anatomy with the march stretched over `durS` seconds of 150 m
 *  ground — enough net distance to clear PEDESTRIAN_MIN_RUN_NET_M either way,
 *  so only the duration bar is in play. */
const marchOver = (durS: number): FilteredPoint[] => [
	fx(0, 0, 0),
	fx(1200, 0, 0),
	fx(1800, 140, 5.4),
	fx(1800 + durS / 2, 215, 5.4),
	fx(1800 + durS, 290, 5.4),
	fx(1900 + durS, 295, 0.2),
	fx(2000 + durS, 1200, 32),
	fx(2100 + durS, 2400, 34),
];
const marchOverSegs = (durS: number) => [
	seg({ startTs: 0, endTs: 2100 + durS }),
	seg({ mode: "train", startTs: 2100 + durS, endTs: 4000 }),
];

/** The march runs SOUTH, so anything that pushes the weighted median PAST the
 *  dwell lands on the ride's far end and the tether refuses. Shared by the two
 *  fixtures that perturb how `half` is computed. */
const southMarch = (head: FilteredPoint[], lastGapS: number): FilteredPoint[] => [
	...head,
	fx(1800, -140, 5.4),
	fx(1850, -215, 5.4),
	fx(1900, -290, 5.4),
	fx(2000, -295, 0.2),
	fx(2100, 1200, 53),
	fx(2100 + lastGapS, 2400, 20),
];
const SOUTH_STEPS = stepsAt(80, 1800, 1900);

const GAP_CASES: Record<string, Case> = {
	// MARCH_START_MAX_FROM_DWELL_M — the first pass pinned neither the gate nor
	// its value. A straddling pair: 140 m carves, 160 m is refused, and nothing
	// else about the two differs.
	marchStart140: { segments: FAR_SEGS, points: farMarch(140), steps: FAR_STEPS },
	marchStart160: { segments: FAR_SEGS, points: farMarch(160), steps: FAR_STEPS },

	// The n < 8 floor. Eight fixes carve; drop one dwell fix and the same
	// anatomy — same march, same ride, same dwell position — is refused.
	eightFixes: { segments: FAR_SEGS, points: farMarch(140), steps: FAR_STEPS },
	sevenFixes: {
		segments: FAR_SEGS,
		points: farMarch(140).filter((_, j) => j !== 1),
		steps: FAR_STEPS,
	},

	// PEDESTRIAN_MIN_RUN_S. The original too-brief case also failed the net
	// bar; these two clear it by 30 m and straddle the 90 s bar alone.
	march80s: { segments: marchOverSegs(80), points: marchOver(80), steps: stepsAt(80, 1800, 1880) },
	march100s: { segments: marchOverSegs(100), points: marchOver(100), steps: stepsAt(80, 1800, 1900) },

	// The `/ 2` in `half`. A 400 m southern outlier holding just over a QUARTER
	// of the total time: the median stays at the dwell, but a quartile would
	// land on the outlier and put the march 540 m from the "dwell".
	quartileOutlier: {
		segments: [seg({ startTs: 0, endTs: 2200 }), seg({ mode: "train", startTs: 2200, endTs: 4000 })],
		points: southMarch([fx(0, -400, 2), fx(700, 0, 0), fx(1400, 0, 0)], 100),
		steps: SOUTH_STEPS,
	},

	// `acc >= half` at an EXACT tie: the dwell holds 2100 s of a 4200 s total,
	// so the cumulative weight lands on half to the second. Under `>` the
	// median falls through to the ride's first fix, 1340 m away.
	weightTie: {
		segments: [seg({ startTs: 0, endTs: 4199 }), seg({ mode: "train", startTs: 4199, endTs: 6000 })],
		points: southMarch([fx(0, 0, 0), fx(1200, 0, 0)], 2099),
		steps: SOUTH_STEPS,
	},

	// holdS's `max(…, 1)` floor. Same tie, but one unit of the dwell's weight
	// now comes from a DUPLICATE timestamp: without the floor that fix holds
	// for zero seconds, the tie breaks the other way, and the carve is refused.
	duplicateTs: {
		segments: [seg({ startTs: 0, endTs: 4200 }), seg({ mode: "train", startTs: 4200, endTs: 6000 })],
		points: southMarch([fx(0, 0, 0), fx(0, 0, 0), fx(1200, 0, 0)], 2100),
		steps: SOUTH_STEPS,
	},
};

const CASES: Record<string, Case> = {
	// stay | walk | train — the stay is cut back, a walk is INVENTED, and the
	// train extends back over the platform wait and the reacquire fixes.
	carved: {},

	// --- who may participate ---
	noSteps: { steps: [] },
	curNotStationary: { segments: [seg({ mode: "walking", startTs: 0, endTs: 4000 }), SEGS[1]] },
	nextNotTrain: { segments: [SEGS[0], seg({ mode: "driving", startTs: 4000, endTs: 6000 })] },
	// Both sides read segMode.
	refinedStationaryAndTrain: {
		segments: [
			seg({ mode: "walking", refinedMode: "stationary", startTs: 0, endTs: 4000 }),
			seg({ mode: "driving", refinedMode: "train", startTs: 4000, endTs: 6000 }),
		],
	},
	noNext: { segments: [SEGS[0]] },
	// Fewer than 8 fixes in the stay: too little to reason over.
	tooFewFixes: { points: [...FIXES.slice(0, 3), ...FIXES.slice(10)] },

	// --- the ride test ---
	// No vehicle-paced step at all: the tail never becomes a ride.
	noRideStep: {
		points: [...FIXES.slice(0, 10), fx(3700, 330, 3), fx(3800, 350, 3), fx(3900, 370, 3), fx(4000, 390, 3)],
	},
	// AN ERRAND AND BACK: there IS a fast step, but the fixes afterwards come
	// back inside DWELL_RETURN_RADIUS_M — the user never left for good.
	errandAndBack: {
		points: [...FIXES.slice(0, 10), fx(3700, 1000, 25), fx(3800, 500, 25), fx(3900, 80, 25), fx(4000, 50, 3)],
	},
	// A ride net BETWEEN 250 and 2000: carves at the real bar, refused if the
	// bar were raised — so the constant's value is pinned, not just its side.
	rideNetMidRange: {
		points: [...FIXES.slice(0, 10), fx(3700, 800, 25), fx(3800, 850, 5), fx(3900, 870, 5), fx(4000, 880, 5)],
	},
	// The ride's net displacement is under RIDE_HEAD_MIN_NET_M.
	rideNetTooShort: {
		points: [...FIXES.slice(0, 10), fx(3700, 500, 25), fx(3800, 520, 3), fx(3900, 540, 3), fx(4000, 560, 3)],
	},

	// --- the march ---
	// No march at all: the fixes step straight from the dwell into the wait.
	noMarch: {
		points: [
			...FIXES.slice(0, 4),
			fx(3100, 5, 0.1),
			fx(3200, 6, 0.1),
			fx(3300, 7, 0.1),
			fx(3400, 8, 0.1),
			...FIXES.slice(8),
		],
	},
	// A step in the march ABOVE the pedestrian ceiling.
	marchNotPedestrianPaced: {
		points: withMarch([fx(3100, 10, 3.6), fx(3200, 110, 3.6), fx(3300, 210, 3.6), fx(3400, 610, 14.4)]),
	},
	// The march is too SHORT in time (< PEDESTRIAN_MIN_RUN_S).
	marchTooBrief: {
		points: withMarch([fx(3320, 10, 3.6), fx(3340, 40, 5.4), fx(3370, 80, 4.8), fx(3400, 130, 6)]),
	},
	// …and too short in NET ground (< PEDESTRIAN_MIN_RUN_NET_M).
	marchNetTooShort: {
		points: withMarch([fx(3100, 10, 1), fx(3200, 40, 1), fx(3300, 70, 1), fx(3400, 100, 1)]),
	},
	// Cadence below the bar, and no cadence data over the march window at all.
	cadenceTooLow: { steps: stepsAt(30, 3100, 3400) },
	cadenceNoData: { steps: stepsAt(80, 100, 400) },
	// The march sets out from somewhere ELSE — beyond
	// MARCH_START_MAX_FROM_DWELL_M of the dwell mass.
	marchStartsAwayFromDwell: {
		points: withMarch([fx(3100, 200, 3.6), fx(3200, 300, 3.6), fx(3300, 400, 3.6), fx(3400, 500, 3.6)]),
	},
	// RIDE_HEAD_MIN_REMAINING_STAY_S needs its OWN geometry: simply moving the
	// stay's startTs also drops the early dwell fixes, which moves the
	// time-weighted dwell mass into the march and refuses for the wrong reason.
	// Here one long-held dwell fix still outweighs the whole 420 s tail, and the
	// march opens exactly 600 s after the stay's start.
	remainingStayAtBar: {
		segments: [seg({ startTs: 0, endTs: 1100 }), seg({ mode: "train", startTs: 1100, endTs: 3000 })],
		points: [
			fx(0, 0, 0),
			fx(600, 10, 6),
			fx(660, 110, 6),
			fx(720, 210, 6),
			fx(780, 310, 6),
			fx(840, 315, 0.3),
			fx(900, 1000, 41),
			fx(960, 2000, 40),
			fx(1020, 3000, 42),
		],
		steps: stepsAt(80, 600, 780),
	},
	// One second under the bar: refused.
	remainingStayTooShort: {
		segments: [seg({ startTs: 1, endTs: 1100 }), seg({ mode: "train", startTs: 1100, endTs: 3000 })],
		points: [
			fx(1, 0, 0),
			fx(600, 10, 6),
			fx(660, 110, 6),
			fx(720, 210, 6),
			fx(780, 310, 6),
			fx(840, 315, 0.3),
			fx(900, 1000, 41),
			fx(960, 2000, 40),
			fx(1020, 3000, 42),
		],
		steps: stepsAt(80, 600, 780),
	},

	// The train already carries a reason: the new one is appended after "; ".
	trainHasReason: {
		segments: [SEGS[0], seg({ mode: "train", startTs: 4000, endTs: 6000, refinedReason: "Victoria Line" })],
	},
	empty: { segments: [], points: [], steps: [] },

	...GAP_CASES,
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
			needsReenrich: x.needsReenrich ?? null,
			refinedReason: x.refinedReason ?? null,
		};
	});

for (const [name, c] of Object.entries(CASES)) {
	const r = claimRideHeadFromStay(c.segments ?? SEGS, c.points ?? FIXES, c.steps ?? STEPS);
	show(`head.${name}`, view(r));
}
