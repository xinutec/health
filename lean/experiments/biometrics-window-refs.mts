/**
 * V8 reference values for the Lean port of the biometrics window
 * aggregations (`src/geo/biometrics.ts`) and the stay bridge
 * (`src/geo/bridge-stays-biometrics.ts`).
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/biometrics-window-refs.mts
 */

import {
	enrichSegmentWithBiometrics,
	stepsInWindow,
	cadenceForSegment,
	peakCadenceForSegment,
	type HrPoint,
	type StepPoint,
	type SleepStageRecord,
} from "../../src/geo/biometrics.js";
import { bridgeStaysWithBiometrics } from "../../src/geo/bridge-stays-biometrics.js";
import type { TrackSegment, TransportMode } from "../../src/geo/segments.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));
const fn = (x: number | null): string => (x === null ? "null" : f(x));

const T0 = 1778457600; // 2026-05-11T00:00:00Z

function seg(startTs: number, endTs: number, mode: TransportMode = "stationary", pointCount = 10): TrackSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.9,
		confidenceMargin: 3,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0.1,
		pointCount,
	};
}
const hr = (ts: number, bpm: number): HrPoint => ({ ts, bpm });
const st = (ts: number, steps: number): StepPoint => ({ ts, steps });

console.log("=== enrichSegmentWithBiometrics ===");
function showEnrich(
	label: string,
	s: TrackSegment,
	hrs: HrPoint[],
	sleep: SleepStageRecord[],
	steps: StepPoint[],
): void {
	const r = enrichSegmentWithBiometrics(s, hrs, sleep, steps);
	console.log(
		`${label}: hrMean=${fn(r.hrMean)} hrMin=${fn(r.hrMin)} hrMax=${fn(r.hrMax)} hrStd=${fn(r.hrStd)} ` +
			`n=${r.sampleCount} sleep=${r.overlapsSleep} frac=${f(r.sleepFraction)} steps=${fn(r.stepsTotal)}`,
	);
}
const s1 = seg(T0 + 3600, T0 + 7200);
showEnrich("no data", s1, [], [], []);
showEnrich(
	"hr in window",
	s1,
	[hr(T0 + 3000, 200), hr(T0 + 3600, 60), hr(T0 + 5000, 72), hr(T0 + 7200, 81), hr(T0 + 9000, 200)],
	[],
	[],
);
// Boundary timestamps are INCLUSIVE on both ends.
showEnrich("hr single sample", s1, [hr(T0 + 5000, 77)], [], []);
showEnrich(
	"sleep overlap partial",
	s1,
	[],
	[{ startTs: T0 + 5400, endTs: T0 + 9000, stage: "light" } as SleepStageRecord],
	[],
);
showEnrich(
	"sleep overlap full",
	s1,
	[],
	[{ startTs: T0, endTs: T0 + 20000, stage: "deep" } as SleepStageRecord],
	[],
);
showEnrich("steps in window", s1, [], [], [st(T0 + 3600, 30), st(T0 + 4000, 45), st(T0 + 9000, 100)]);
// Step rows exist for the day but none inside the window => zero, not null.
showEnrich("steps same day, none in window", s1, [], [], [st(T0 + 20000, 50)]);
// Step rows far from the segment's day => null (no Fitbit data).
showEnrich("steps far away", s1, [], [], [st(T0 + 500000, 50)]);
showEnrich("zero-length segment", seg(T0, T0), [hr(T0, 65)], [{ startTs: T0 - 10, endTs: T0 + 10, stage: "rem" } as SleepStageRecord], []);

console.log("");
console.log("=== stepsInWindow ===");
console.log(`empty series: ${fn(stepsInWindow([], T0, T0 + 3600))}`);
console.log(`in window: ${fn(stepsInWindow([st(T0 + 60, 20), st(T0 + 120, 30)], T0, T0 + 3600))}`);
console.log(`boundary inclusive: ${fn(stepsInWindow([st(T0, 20), st(T0 + 3600, 30)], T0, T0 + 3600))}`);
console.log(`same day, none in window: ${fn(stepsInWindow([st(T0 + 40000, 20)], T0, T0 + 3600))}`);
console.log(`different day: ${fn(stepsInWindow([st(T0 + 200000, 20)], T0, T0 + 3600))}`);
console.log(`exactly 86400 away: ${fn(stepsInWindow([st(T0 + 86400, 20)], T0, T0 + 3600))}`);
console.log(`86399 away: ${fn(stepsInWindow([st(T0 + 86399, 20)], T0, T0 + 3600))}`);

console.log("");
console.log("=== cadenceForSegment / peakCadenceForSegment ===");
const steps1 = [st(T0 + 3600, 30), st(T0 + 3660, 90), st(T0 + 3720, 60), st(T0 + 20000, 500)];
console.log(`cadence 1h: ${f(cadenceForSegment(seg(T0 + 3600, T0 + 7200), steps1))}`);
console.log(`cadence 3min: ${f(cadenceForSegment(seg(T0 + 3600, T0 + 3780), steps1))}`);
console.log(`cadence 29s: ${f(cadenceForSegment(seg(T0 + 3600, T0 + 3629), steps1))}`);
console.log(`cadence 30s: ${f(cadenceForSegment(seg(T0 + 3600, T0 + 3630), steps1))}`);
console.log(`cadence no steps: ${f(cadenceForSegment(seg(T0 + 50000, T0 + 53600), steps1))}`);
console.log(`peak 1h: ${f(peakCadenceForSegment(seg(T0 + 3600, T0 + 7200), steps1))}`);
console.log(`peak none: ${f(peakCadenceForSegment(seg(T0 + 50000, T0 + 53600), steps1))}`);

console.log("");
console.log("=== bridgeStaysWithBiometrics ===");
type Cent = readonly [number, number] | null;
const HOME: Cent = [51.5205, -0.1275];
const NEAR: Cent = [51.5206, -0.1276]; // ~13 m
const FAR: Cent = [51.53, -0.14]; // ~1.7 km

function showBridge(
	label: string,
	segments: TrackSegment[],
	centroids: Cent[],
	hrs: HrPoint[] = [],
	steps: StepPoint[] = [],
): void {
	const out = bridgeStaysWithBiometrics({ segments, centroids, hr: hrs, steps });
	console.log(
		`${label}: ${out.length} segs -> ${out
			.map((s) => `[${s.startTs - T0}..${s.endTs - T0} ${s.mode} n=${s.pointCount}]`)
			.join(" ")}`,
	);
}

// Quiet HR + zero steps across a 5-minute gap: bridge. All three HR samples
// must sit STRICTLY inside the gap — a sample on the boundary belongs to the
// bracketing stay, not the gap (see `quietHrBoundary` below).
const quietHr = [hr(T0 + 3700, 62), hr(T0 + 3750, 63), hr(T0 + 3800, 64)];
const zeroSteps = [st(T0 + 3700, 0), st(T0 + 3800, 0)];
showBridge(
	"gap bridged (quiet HR, no steps)",
	[seg(T0, T0 + 3600), seg(T0 + 3900, T0 + 7200)],
	[HOME, NEAR],
	quietHr,
	zeroSteps,
);
// Same data but the third sample lands exactly on the gap's closing boundary,
// so only two count and the bridge is refused.
showBridge(
	"boundary HR sample does not count",
	[seg(T0, T0 + 3600), seg(T0 + 3900, T0 + 7200)],
	[HOME, NEAR],
	[hr(T0 + 3700, 62), hr(T0 + 3800, 64), hr(T0 + 3900, 61)],
	zeroSteps,
);
showBridge(
	"gap NOT bridged (high HR)",
	[seg(T0, T0 + 3600), seg(T0 + 3900, T0 + 7200)],
	[HOME, NEAR],
	[hr(T0 + 3700, 120), hr(T0 + 3800, 130), hr(T0 + 3900, 125)],
	zeroSteps,
);
showBridge(
	"gap NOT bridged (steps taken)",
	[seg(T0, T0 + 3600), seg(T0 + 3900, T0 + 7200)],
	[HOME, NEAR],
	quietHr,
	[st(T0 + 3700, 40)],
);
showBridge(
	"gap NOT bridged (too few HR samples)",
	[seg(T0, T0 + 3600), seg(T0 + 3900, T0 + 7200)],
	[HOME, NEAR],
	[hr(T0 + 3700, 62), hr(T0 + 3800, 64)],
	zeroSteps,
);
showBridge("gap NOT bridged (not co-located)", [seg(T0, T0 + 3600), seg(T0 + 3900, T0 + 7200)], [HOME, FAR], quietHr, zeroSteps);
showBridge(
	"gap NOT bridged (> 10 min)",
	[seg(T0, T0 + 3600), seg(T0 + 4400, T0 + 7200)],
	[HOME, NEAR],
	quietHr,
	zeroSteps,
);
showBridge("gap NOT bridged (null centroid)", [seg(T0, T0 + 3600), seg(T0 + 3900, T0 + 7200)], [HOME, null], quietHr, zeroSteps);
// Back-to-back co-located stays: merged on the segment-level HR check alone.
showBridge("back-to-back merged", [seg(T0, T0 + 3600), seg(T0 + 3600, T0 + 7200)], [HOME, NEAR]);
showBridge(
	"back-to-back NOT merged (exercise HR)",
	[seg(T0, T0 + 3600), seg(T0 + 3600, T0 + 7200)],
	[HOME, NEAR],
	[hr(T0 + 100, 150), hr(T0 + 200, 160)],
);
// Non-stationary segments pass through untouched.
showBridge(
	"walking passes through",
	[seg(T0, T0 + 3600), seg(T0 + 3600, T0 + 5400, "walking"), seg(T0 + 5400, T0 + 7200)],
	[HOME, NEAR, NEAR],
);
// A three-way run collapses to one.
showBridge(
	"three back-to-back merged",
	[seg(T0, T0 + 1800), seg(T0 + 1800, T0 + 3600), seg(T0 + 3600, T0 + 5400)],
	[HOME, NEAR, NEAR],
);
showBridge("single segment", [seg(T0, T0 + 3600)], [HOME]);
showBridge("empty", [], []);
