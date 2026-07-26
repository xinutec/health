/**
 * V8 reference values for `splitStaysOnEvidence` (`src/geo/stay-split.ts`),
 * with its private `splitByEvidence` driven through it.
 *
 * A stay is one segment because the GPS never moved — but a phone that sits in
 * a pocket through a walk to the shops and back looks exactly like a phone on a
 * table, so `findStays` swallows the errand. This pass re-reads each stay's own
 * fix sequence and asks, at every gap long enough to hide a departure, whether
 * the BIOMETRICS say the wearer left: step density above all, with the gap's
 * anomaly against the run's own rhythm, HR elevation and post-gap proximity as
 * supporting signals (`scoreSplitEvidence`, already in Lean).
 *
 * Where the evidence carries, the stay is cut and an explicit `unknown` segment
 * is emitted BETWEEN the sub-stays — the honest "no coverage here" rather than
 * two stays that `mergeAdjacent` would quietly stitch back together.
 *
 * Three details the cases below exist to pin:
 *  - the run centroid is a RUNNING MEAN over the sub-run so far, not the last
 *    fix and not the segment's centroid, so the proximity counter-evidence is
 *    measured against where the wearer has been sitting;
 *  - a long gap that does NOT split still joins `priorGapsInRun`, so it raises
 *    the median the NEXT gap is judged against — one unexplained silence makes
 *    the next silence less anomalous;
 *  - the step and HR windows are STRICT at both ends.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/split-stays-refs.mts
 */

import type { HrPoint, StepPoint } from "../../src/geo/biometrics.js";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import { splitStaysOnEvidence } from "../../src/geo/stay-split.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const fx = (ts: number, metresNorth: number): FilteredPoint =>
	({ ts, lat: LAT0 + metresNorth * MLAT, lon: LON0, accuracy: 10, speed_kmh: 0, bearing: 0 }) as FilteredPoint;

const seg = (o: Record<string, unknown>) =>
	({
		mode: "stationary",
		startTs: 0,
		endTs: 100000,
		// Set explicitly so the guards pin INHERITANCE across the split rather
		// than inferring it from an absent field.
		confidence: 0.8,
		confidenceMargin: 2,
		avgSpeed: 0,
		maxSpeed: 1,
		linearity: 0.1,
		pointCount: 9,
		place: "Home",
		...o,
	}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const STAY = [seg({})];

/** `n` step buckets of `spm` each, one per minute from `from`. */
const stepsFrom = (spm: number, from: number, n: number): StepPoint[] =>
	Array.from({ length: n }, (_, k) => ({ ts: from + 60 * k, steps: spm }));
const hrFrom = (bpm: number, from: number, n: number): HrPoint[] =>
	Array.from({ length: n }, (_, k) => ({ ts: from + 60 * k, bpm }));

/** Four dense fixes, a `gapS` silence, then three more. */
const acrossGap = (gapS: number): FilteredPoint[] => [
	fx(0, 0),
	fx(300, 0),
	fx(600, 0),
	fx(900, 0),
	fx(900 + gapS, 500),
	fx(1200 + gapS, 500),
	fx(1500 + gapS, 500),
];

type Case = {
	segments?: ReturnType<typeof seg>[];
	points?: FilteredPoint[];
	hr?: HrPoint[];
	steps?: StepPoint[];
};

const CASES: Record<string, Case> = {
	// 800 steps over the 30 min silence = 26.7/min, unambiguous walking: the
	// stay is cut and an `unknown` segment records the uncovered half hour.
	split: { points: acrossGap(1800), steps: stepsFrom(100, 960, 8) },
	// The same silence with no steps at all: sitting quietly, left alone.
	noSteps: { points: acrossGap(1800) },

	// WHO PARTICIPATES. `seg.mode` is read RAW — a refinement in either
	// direction is ignored, unlike almost every sibling pass in this file.
	notStationary: {
		segments: [seg({ mode: "walking" })],
		points: acrossGap(1800),
		steps: stepsFrom(100, 960, 8),
	},
	refinedStationaryIgnored: {
		segments: [seg({ mode: "walking", refinedMode: "stationary" })],
		points: acrossGap(1800),
		steps: stepsFrom(100, 960, 8),
	},
	refinedWalkingStillSplits: {
		segments: [seg({ mode: "stationary", refinedMode: "walking" })],
		points: acrossGap(1800),
		steps: stepsFrom(100, 960, 8),
	},
	// The segment's own pointCount gates entry, whatever the fixes say.
	pointCount1: {
		segments: [seg({ pointCount: 1 })],
		points: acrossGap(1800),
		steps: stepsFrom(100, 960, 8),
	},
	pointCount2: {
		segments: [seg({ pointCount: 2 })],
		points: acrossGap(1800),
		steps: stepsFrom(100, 960, 8),
	},
	// …and the window must actually hold two fixes.
	oneFixInWindow: {
		segments: [seg({ startTs: 0, endTs: 100 })],
		points: acrossGap(1800),
		steps: stepsFrom(100, 960, 8),
	},

	// MIN_GAP_TO_EVALUATE_S is a floor, not a strict bar: exactly 900 s is
	// evaluated (and splits), 899 s is joined without ever being scored.
	gap900: { points: acrossGap(900), steps: stepsFrom(100, 960, 8) },
	gap899: { points: acrossGap(899), steps: stepsFrom(100, 960, 8) },

	// SPLIT_THRESHOLD_NATS is strict. 10 steps/min (2.0) with a 20× anomalous
	// gap (+0.5) lands on 2.5 exactly and is refused; the same gap with three
	// elevated HR samples (+0.3) clears it.
	scoreExactly2p5: {
		points: [fx(0, 0), fx(60, 0), fx(120, 0), fx(180, 0), fx(240, 0), fx(1440, 500), fx(1740, 500)],
		steps: stepsFrom(10, 300, 20),
	},
	scoreOver2p5: {
		points: [fx(0, 0), fx(60, 0), fx(120, 0), fx(180, 0), fx(240, 0), fx(1440, 500), fx(1740, 500)],
		steps: stepsFrom(10, 300, 20),
		hr: hrFrom(100, 300, 3),
	},
	// The HR window is STRICT at both ends and needs three samples: pushing one
	// of the three onto the boundary fix drops the count to two and the +0.3.
	hrSampleOnBoundary: {
		points: [fx(0, 0), fx(60, 0), fx(120, 0), fx(180, 0), fx(240, 0), fx(1440, 500), fx(1740, 500)],
		steps: stepsFrom(10, 300, 20),
		hr: [
			{ ts: 240, bpm: 100 },
			{ ts: 360, bpm: 100 },
			{ ts: 420, bpm: 100 },
		],
	},
	// The step window is strict too: 1200 steps sitting exactly ON the two
	// boundary fixes are not in the gap, so the score falls to sitting.
	stepsOnBoundaries: {
		points: acrossGap(1800),
		steps: [
			{ ts: 900, steps: 600 },
			{ ts: 2700, steps: 600 },
		],
	},

	// The run centroid is a RUNNING MEAN over the sub-run. The run sits at 0, 0,
	// 0, 0 and then 75 m, so its mean is 15 m: the post-gap fix at 25 m is 10 m
	// from that mean, which is close enough to spend the −0.5 and land the
	// score on 2.5 exactly. Measured from the LAST fix (50 m) or the FIRST
	// (25 m) there would be no penalty and the stay would split.
	centroidIsRunningMean: {
		points: [fx(0, 0), fx(60, 0), fx(120, 0), fx(180, 0), fx(240, 75), fx(3840, 25), fx(4140, 25)],
		steps: stepsFrom(10, 300, 60),
	},

	// A long gap that does NOT split still joins priorGapsInRun, raising the
	// median the NEXT gap is judged against from 60 s to 430 s — so the second
	// silence, 60× the original rhythm on the un-updated median, is no longer
	// anomalous enough to carry a 10 steps/min run over the bar. Drop that
	// push and this stay splits.
	priorGapsAccumulate: {
		points: [fx(0, 0), fx(60, 0), fx(120, 0), fx(920, 0), fx(2120, 500), fx(5720, 1000), fx(6020, 1000)],
		steps: stepsFrom(10, 2160, 60),
	},

	// Two splits: three sub-stays, two `unknown` segments. The second gap is
	// 1830 s, so the minutes in its reason round HALF UP to 31.
	twoSplits: {
		points: [
			fx(0, 0),
			fx(300, 0),
			fx(900, 0),
			fx(2700, 500),
			fx(3000, 500),
			fx(4830, 1000),
			fx(5130, 1000),
		],
		steps: [...stepsFrom(100, 960, 8), ...stepsFrom(100, 3060, 30)],
	},

	// A synthetic stay whose window holds NO fixes at all. The guard that keeps
	// it out is protective: `splitByEvidence` reads fixes[0] before its loop.
	noFixesInWindow: {
		segments: [seg({ startTs: 50000, endTs: 60000 })],
		points: acrossGap(1800),
		steps: stepsFrom(100, 960, 8),
	},

	// The gap's HIGH end is strict too, and here it decides: a 300-step bucket
	// sitting exactly on the post-gap fix would lift 9.5 steps/min to 24.5 and
	// carry the score from 2.5 to 4.0.
	stepBucketOnPostFix: {
		points: [fx(0, 0), fx(60, 0), fx(120, 0), fx(180, 0), fx(240, 0), fx(1440, 500), fx(1740, 500)],
		steps: [...stepsFrom(10, 300, 20), { ts: 1440, steps: 300 }],
	},

	// A split starts a FRESH rhythm: priorGapsInRun is cleared, so the new
	// run's 60 s cadence — not the old run's 800 s one — is what the next
	// silence is judged against. Carry the old gaps over and the median rises
	// to 800, the boost is lost, and this stay splits once instead of twice.
	splitClearsPriorGaps: {
		points: [
			fx(0, 0),
			fx(800, 0),
			fx(1600, 0),
			fx(2400, 0),
			fx(3200, 0),
			fx(4000, 0),
			fx(5800, 500),
			fx(5860, 500),
			fx(5920, 500),
			fx(5980, 500),
			fx(6040, 500),
			fx(9640, 1000),
			fx(9940, 1000),
		],
		steps: [...stepsFrom(100, 4060, 8), ...stepsFrom(10, 6060, 60)],
	},

	// …and the centroid is reset to the new run's first fix. The second run
	// sits at 1000 m and the final fix lands 10 m from it — close enough for
	// the −0.5 that holds the score at 2.5. Left un-reset the centroid would
	// still be dragging up from the old run at 800 m, 210 m away, and this
	// would split a second time.
	splitResetsCentroid: {
		points: [
			fx(0, 0),
			fx(60, 0),
			fx(120, 0),
			fx(180, 0),
			fx(1980, 1000),
			fx(2040, 1000),
			fx(2100, 1000),
			fx(2160, 1000),
			fx(2220, 1000),
			fx(5820, 1010),
			fx(6120, 1010),
		],
		steps: [...stepsFrom(100, 240, 8), ...stepsFrom(10, 2240, 60)],
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
			pointCount: x.pointCount ?? null,
			confidence: x.confidence ?? null,
			confidenceMargin: x.confidenceMargin ?? null,
			place: x.place ?? null,
			refinedReason: x.refinedReason ?? null,
		};
	});

for (const [name, c] of Object.entries(CASES)) {
	const r = splitStaysOnEvidence(c.segments ?? STAY, c.points ?? [], {
		hr: c.hr ?? [],
		steps: c.steps ?? [],
	});
	show(`stays.${name}`, view(r));
}
