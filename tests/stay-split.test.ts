/**
 * Multi-signal weighted stay-split tests for stay-split.ts.
 *
 * Pinned cases reflecting the conservative-by-design calibration:
 *
 *   1. **Clear walking-rate steps in gap + anomalous gap → split.**
 *      Hypothetical out-and-back walk where the step recorder caught
 *      the activity. The combined signal clears the threshold.
 *
 *   2. **Ambiguous step density (≈3/min) + anomalous gap → no split.**
 *      The real 04-29 Parkhotel pattern. Step count is too low to
 *      distinguish "brief errand" from "at-place fidgeting"; gap-
 *      anomaly alone can't carry the split.
 *
 *   3. **Lone-fix sparse cluster + zero in-gap activity → no split.**
 *      The 04-30 parents'-flat pattern. No pre-gap density, no
 *      biometric signal — keep merged.
 *
 *   4. **Heavy step rate alone → split.** Step count > 20/min clears
 *      the threshold even without GPS-density support.
 *
 *   5. **Quiet at-home evening with brief GPS gap → no split.** The
 *      false-positive shape we had to calibrate against (05-11
 *      regression in the first pass).
 *
 * The scoring helper `scoreSplitEvidence` is tested in isolation so
 * the per-signal contributions are pinned; `splitStaysOnEvidence`
 * is tested end-to-end on synthesised stay shapes.
 */

import { describe, expect, it } from "vitest";
import type { HrPoint, StepPoint } from "../src/geo/biometrics.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment } from "../src/geo/segments.js";
import { scoreSplitEvidence, splitStaysOnEvidence } from "../src/geo/stay-split.js";

function fix(ts: number, lat: number, lon: number): FilteredPoint {
	return { ts, lat, lon, speed_kmh: 0, bearing: 0 };
}

function stay(startTs: number, endTs: number, pointCount: number): TrackSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 0.9,
		confidenceMargin: 1000,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount,
	};
}

describe("scoreSplitEvidence", () => {
	it("clears split threshold when step density is clearly walking + gap is anomalous", () => {
		// Hypothetical: user walked out and back, with step recorder
		// catching the activity. ~10 steps/min sustained over 78 min →
		// ~780 steps in gap, clear movement. Plus 142x gap-anomaly.
		const score = scoreSplitEvidence({
			gapDurationS: 4703, // 78 min
			medianPriorGapS: 33,
			preGapFixCount: 13,
			stepsInGap: 780, // ≈ 10 steps/min — clear movement
			hrMeanInGap: 100,
			hrSamplesInGap: 50,
			postGapDistFromCentroidM: 52,
		});
		expect(score, "clear in-gap movement + anomalous gap should split").toBeGreaterThan(2.5);
	});

	it("does NOT split on gap-anomaly alone when in-gap step count is low", () => {
		// The real 04-29 Parkhotel pattern: very anomalous gap (142x),
		// but step count averages only ~3/min — too low to distinguish
		// from at-place fidgeting. Honest call: don't split. The data
		// genuinely cannot tell us whether the user briefly stepped out
		// or sat silently with the phone idle.
		const score = scoreSplitEvidence({
			gapDurationS: 4703,
			medianPriorGapS: 33,
			preGapFixCount: 13,
			stepsInGap: 230, // ≈ 3 steps/min — ambiguous
			hrMeanInGap: 100,
			hrSamplesInGap: 50,
			postGapDistFromCentroidM: 52,
		});
		expect(score, "ambiguous step density should not split even on anomalous gap").toBeLessThan(2.5);
	});

	it("does not split a lone-fix cluster with no in-gap activity", () => {
		// Mirrors 04-30 parents' pattern.
		const score = scoreSplitEvidence({
			gapDurationS: 11168, // 3h6m
			medianPriorGapS: 0, // no prior gaps in cluster
			preGapFixCount: 1,
			stepsInGap: 0,
			hrMeanInGap: 72, // restful
			hrSamplesInGap: 100,
			postGapDistFromCentroidM: 95,
		});
		expect(score, "lone-fix + no activity should not split").toBeLessThan(1.5);
	});

	it("splits on heavy step activity even without GPS-density signal", () => {
		// Cluster has 1 pre-gap fix (no density signal), but step count
		// during gap is unambiguous walking activity.
		const score = scoreSplitEvidence({
			gapDurationS: 30 * 60, // 30 min
			medianPriorGapS: 0,
			preGapFixCount: 1,
			stepsInGap: 1500, // = 50 steps/min, sustained walking
			hrMeanInGap: 110,
			hrSamplesInGap: 10,
			postGapDistFromCentroidM: 100,
		});
		expect(score, "heavy step activity alone should split").toBeGreaterThan(1.5);
	});

	it("does not split a quiet evening at home with brief in-stay GPS gaps", () => {
		// Mirrors the false-positive shape from 05-11: home stay, normal
		// fix density, 20-min gap with no in-gap activity (user on the
		// sofa, phone idle).
		const score = scoreSplitEvidence({
			gapDurationS: 24 * 60,
			medianPriorGapS: 60,
			preGapFixCount: 8,
			stepsInGap: 5, // negligible — at-place fidgeting
			hrMeanInGap: 70,
			hrSamplesInGap: 20,
			postGapDistFromCentroidM: 15,
		});
		expect(score, "quiet at-home gap should not split").toBeLessThan(2.5);
	});
});

describe("splitStaysOnEvidence", () => {
	it("splits a stay with clear in-gap walking activity (dense pre-gap + walking-rate steps + anomalous gap)", () => {
		const t0 = 1_700_000_000;
		const lat = 52.08008;
		const lon = 4.30385;
		const points: FilteredPoint[] = [];
		// 13 dense fixes at 30-34 s spacing, 7 min total.
		for (let i = 0; i < 13; i++) {
			points.push(fix(t0 + i * 33, lat + (i % 3) * 1e-7, lon));
		}
		// 78-min gap (no fixes).
		const gapStart = t0 + 12 * 33;
		const gapEnd = gapStart + 78 * 60;
		// One return fix near (but not exactly on) centroid.
		points.push(fix(gapEnd, lat - 0.0003, lon));

		const seg = stay(points[0].ts, points[points.length - 1].ts, points.length);
		const steps: StepPoint[] = [];
		// ~10 steps/min across the gap = clear walking activity.
		for (let m = 1; m < 78; m++) {
			steps.push({ ts: gapStart + m * 60, steps: 10 });
		}
		const hr: HrPoint[] = [];
		for (let m = 0; m < 78; m += 5) {
			hr.push({ ts: gapStart + m * 60, bpm: 105 });
		}

		const result = splitStaysOnEvidence([seg], points, { hr, steps });
		const stays = result.filter((s) => s.mode === "stationary");
		expect(stays.length, "walking-rate steps in gap should split the stay").toBeGreaterThanOrEqual(2);
	});

	it("keeps a parents'-shaped stay merged (sparse + zero in-gap activity)", () => {
		const t0 = 1_700_000_000;
		const lat = 51.84579;
		const lon = 5.86304;
		// Two lone fixes 3h6m apart, both at the same place.
		const points: FilteredPoint[] = [fix(t0, lat, lon), fix(t0 + 11168, lat + 0.0005, lon - 0.0005)];
		const seg = stay(points[0].ts, points[1].ts, 2);

		// Zero steps in gap, restful HR.
		const steps: StepPoint[] = [];
		const hr: HrPoint[] = [];
		for (let m = 0; m < 186; m += 5) {
			hr.push({ ts: t0 + m * 60, bpm: 70 });
		}

		const result = splitStaysOnEvidence([seg], points, { hr, steps });
		const stays = result.filter((s) => s.mode === "stationary");
		expect(stays.length, "parents'-pattern stay should remain a single stay").toBe(1);
	});

	it("splits even a sparse stay when in-gap step count is unambiguously walking", () => {
		const t0 = 1_700_000_000;
		const lat = 51.5;
		const lon = -0.1;
		const points: FilteredPoint[] = [fix(t0, lat, lon), fix(t0 + 30 * 60, lat + 0.001, lon)];
		const seg = stay(points[0].ts, points[1].ts, 2);

		// 1500 steps across 30 min in the gap = 50 steps/min (brisk walking).
		const steps: StepPoint[] = [];
		for (let m = 0; m < 30; m++) {
			steps.push({ ts: t0 + m * 60, steps: 50 });
		}
		const hr: HrPoint[] = [];
		for (let m = 0; m < 30; m += 2) {
			hr.push({ ts: t0 + m * 60, bpm: 110 });
		}

		const result = splitStaysOnEvidence([seg], points, { hr, steps });
		const stays = result.filter((s) => s.mode === "stationary");
		expect(stays.length, "in-gap walking activity should split the stay").toBeGreaterThanOrEqual(2);
	});

	it("passes through non-stationary and pointCount=0 segments untouched", () => {
		const walking: TrackSegment = {
			startTs: 100,
			endTs: 200,
			mode: "walking",
			confidence: 0.8,
			confidenceMargin: 5,
			avgSpeed: 5,
			maxSpeed: 7,
			linearity: 0.5,
			pointCount: 10,
		};
		const unknown: TrackSegment = {
			startTs: 200,
			endTs: 300,
			mode: "unknown",
			confidence: 0.1,
			confidenceMargin: 1,
			avgSpeed: 0,
			maxSpeed: 0,
			linearity: 0,
			pointCount: 0,
		};
		const result = splitStaysOnEvidence([walking, unknown], [], { hr: [], steps: [] });
		expect(result).toEqual([walking, unknown]);
	});
});
