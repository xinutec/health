/**
 * V8 reference values for `splitWalksOnEvidence` (`src/geo/stay-split.ts`).
 *
 * The Cleveland-Clinic shape (#245): an hour sitting indoors, where jittery
 * GPS never settles, followed by the real ten-minute walk out — segmented as
 * ONE walking segment, because the jitter looks like movement all the way
 * through. The fix is to stop asking the GPS and ask the STEP COUNTER: bucket
 * cadence per minute across the segment and carve the low-cadence edge runs
 * out as sits.
 *
 * The boundary search is the whole algorithm, and it is deliberately not
 * "first/last minute below a threshold". A real indoor sit is NOT contiguous
 * zeros — the clinic hour has isolated fidget spikes (a walk to the consult
 * room, reception) — so a threshold walk would cut the sit at the first spike.
 * Instead the sit → walk boundary is the first minute b that BOTH carries real
 * steps itself and opens a forward window averaging sustained-walking cadence,
 * while everything before b averages at sitting level. A lone spike fails the
 * window; the walk onset passes immediately.
 *
 * Carving only fires when what remains still looks like a walk — otherwise the
 * segment is left whole for the demotion pass to judge. This one handles only
 * the MIXED case.
 *
 * The sits come out with their GPS motion stats ZEROED: they are jitter
 * artifacts, and the zero is the claim being made about them.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/split-walks-refs.mts
 */

import type { HrPoint, StepPoint } from "../../src/geo/biometrics.js";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import { splitWalksOnEvidence } from "../../src/geo/stay-split.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const fx = (ts: number): FilteredPoint =>
	({ ts, lat: LAT0, lon: LON0, accuracy: 10, speed_kmh: 1, bearing: 0 }) as FilteredPoint;

const seg = (o: Record<string, unknown>) =>
	({
		mode: "walking",
		startTs: 0,
		endTs: 1800,
		confidence: 0.8,
		confidenceMargin: 2,
		avgSpeed: 3,
		maxSpeed: 6,
		linearity: 0.7,
		pointCount: 40,
		place: "Clinic",
		...o,
	}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** `n` copies of `v` — a run of per-minute cadences. */
const run = (n: number, v: number): number[] => Array.from({ length: n }, () => v);
/** One step row per minute from the segment start, including the zeros. */
const perMin = (cadence: number[]): StepPoint[] => cadence.map((steps, k) => ({ ts: 60 * k, steps }));

/** A fix every 5 minutes across a `mins`-long segment, plus one exactly on the
 *  20-minute mark to pin the half-open [from, to) counting. */
const fixesEvery5 = (mins: number): FilteredPoint[] =>
	Array.from({ length: Math.floor(mins / 5) + 1 }, (_, k) => fx(300 * k));

type Case = {
	segments?: ReturnType<typeof seg>[];
	points?: FilteredPoint[];
	hr?: HrPoint[];
	steps?: StepPoint[];
};

/** 20 min of sitting, then a 10 min walk out — the clinic shape. */
const CLINIC = [...run(20, 0), ...run(10, 60)];

const CASES: Record<string, Case> = {
	// The shape the pass exists for: the sit is carved off the front, the walk
	// keeps the rest, and the sit's motion stats come out zeroed.
	clinic: { points: fixesEvery5(30), steps: perMin(CLINIC) },
	// Mirrored: the walk comes first and the sit is carved off the back.
	walkThenSit: {
		points: fixesEvery5(30),
		steps: perMin([...run(10, 60), ...run(20, 0)]),
	},
	// Both ends: sit, walk, sit — three segments out.
	sitWalkSit: {
		segments: [seg({ endTs: 3000 })],
		points: fixesEvery5(50),
		steps: perMin([...run(20, 0), ...run(10, 60), ...run(20, 0)]),
	},
	// No sit at all: a walk right through is left alone.
	allWalk: { points: fixesEvery5(30), steps: perMin(run(30, 60)) },

	// WHO PARTICIPATES. `seg.mode` is read RAW here too.
	notWalking: {
		segments: [seg({ mode: "stationary", refinedMode: "walking" })],
		points: fixesEvery5(30),
		steps: perMin(CLINIC),
	},
	refinedStationaryStillSplits: {
		segments: [seg({ refinedMode: "stationary" })],
		points: fixesEvery5(30),
		steps: perMin(CLINIC),
	},
	// The duration bar is a floor: exactly 20 min is evaluated, 1 s under is not.
	// 15 min of sitting then a 5 min walk fits in exactly 20 minutes.
	segment1200s: {
		segments: [seg({ endTs: 1200 })],
		points: fixesEvery5(20),
		steps: perMin([...run(15, 0), ...run(5, 60)]),
	},
	segment1199s: {
		segments: [seg({ endTs: 1199 })],
		points: fixesEvery5(20),
		steps: perMin([...run(15, 0), ...run(5, 60)]),
	},
	// FRESHNESS: with the step stream dead around the segment, zero steps is
	// absence of data, not evidence of sitting.
	staleSteps: {
		points: fixesEvery5(30),
		steps: [{ ts: -600, steps: 900 }],
	},

	// THE SIT MUST BE LONG ENOUGH. The prefix search opens at minute 15, so a
	// 15 min sit carves and a 14 min one cannot — at b = 15 the walk's own
	// first minute is already inside the "sit" mean and lifts it over the bar.
	sit15min: {
		points: fixesEvery5(30),
		steps: perMin([...run(15, 0), ...run(15, 100)]),
	},
	sit14min: {
		points: fixesEvery5(30),
		steps: perMin([...run(14, 0), ...run(16, 100)]),
	},

	// A LONE FIDGET SPIKE inside the sit does not move the boundary: minute 20
	// carries 100 steps but its forward window averages 33, under the
	// sustained-walking bar, so the boundary waits for the real onset at 25 —
	// where the spike has diluted into a prefix mean of 4, just inside the
	// sitting bar of 5.
	fidgetSpikeInSit: {
		segments: [seg({ endTs: 2100 })],
		points: fixesEvery5(35),
		steps: perMin([...run(20, 0), 100, ...run(4, 0), ...run(10, 100)]),
	},

	// THE ONSET MINUTE itself must carry steps: exactly 10 is enough, 9 pushes
	// the boundary a minute later (and the 10 lost from the walk changes the
	// carve).
	onsetExactly10: {
		points: fixesEvery5(30),
		steps: perMin([...run(20, 0), 10, ...run(9, 100)]),
	},
	onset9: {
		points: fixesEvery5(30),
		steps: perMin([...run(20, 0), 9, ...run(9, 100)]),
	},
	// Two step rows in the same minute ACCUMULATE — 6 + 6 clears the bar of 10
	// that neither would alone.
	sameMinuteAccumulates: {
		points: fixesEvery5(30),
		steps: [
			...perMin([...run(20, 0), 0, ...run(9, 100)]),
			{ ts: 1200, steps: 6 },
			{ ts: 1230, steps: 6 },
		],
	},

	// THE CARVED CORE MUST STILL BE A WALK. A 3 min core survives; 2 min is
	// under the floor and the whole segment is left intact.
	core180s: {
		segments: [seg({ endTs: 1980 })],
		points: fixesEvery5(33),
		steps: perMin([...run(15, 0), ...run(3, 200), ...run(15, 0)]),
	},
	core120s: {
		segments: [seg({ endTs: 1920 })],
		points: fixesEvery5(32),
		steps: perMin([...run(15, 0), ...run(2, 200), ...run(15, 0)]),
	},
	// …and it must average sustained-walking cadence. A trailing lull too short
	// to carve stays inside the core and drags its mean under the bar.
	coreMean42: {
		segments: [seg({ endTs: 1740 })],
		points: fixesEvery5(29),
		steps: perMin([...run(15, 0), ...run(6, 100), ...run(8, 0)]),
	},
	coreMean37: {
		segments: [seg({ endTs: 1860 })],
		points: fixesEvery5(31),
		steps: perMin([...run(15, 0), ...run(6, 100), ...run(10, 0)]),
	},

	// Step rows outside the segment's own minutes are not bucketed: one just
	// before the start and one past the last minute are both dropped, so this
	// is the clinic shape with a spike that changes nothing.
	rowsOutsideWindow: {
		points: fixesEvery5(30),
		steps: [...perMin(CLINIC), { ts: -30, steps: 900 }, { ts: 1800, steps: 900 }],
	},

	// The onset window's LENGTH, from the short side. Four minutes at 50 average
	// 50 — walking — but stretched over six they average 33 and the boundary has
	// to wait for the minute after, where the window reaches past the lull into
	// the real walk. A shorter window would open the walk a minute early.
	onsetWindowLength: {
		segments: [seg({ endTs: 2160 })],
		points: fixesEvery5(36),
		steps: perMin([...run(20, 0), ...run(4, 50), ...run(2, 0), ...run(10, 100)]),
	},

	// A segment that does not end on a minute boundary: the bucket count is a
	// CEILING, so the last bucket runs 30 s past `endTs` — and the core's end is
	// clamped back to `endTs`, not to that overhanging bucket.
	ragged1830s: {
		segments: [seg({ endTs: 1830 })],
		points: fixesEvery5(30),
		steps: perMin(CLINIC),
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
			avgSpeed: x.avgSpeed ?? null,
			maxSpeed: x.maxSpeed ?? null,
			linearity: x.linearity ?? null,
			place: x.place ?? null,
			refinedReason: x.refinedReason ?? null,
		};
	});

for (const [name, c] of Object.entries(CASES)) {
	const r = splitWalksOnEvidence(c.segments ?? [seg({})], c.points ?? [], {
		hr: c.hr ?? [],
		steps: c.steps ?? [],
	});
	show(`walks.${name}`, view(r));
}
