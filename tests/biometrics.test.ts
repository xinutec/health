import { describe, expect, it } from "vitest";
import {
	applyStationaryWalkThrough,
	type BiometricEnrichment,
	cadenceForSegment,
	correctModeFromCadence,
	correctStationaryWalkThrough,
	demoteJitterWalkToStationary,
	enrichSegmentWithBiometrics,
	type HrPoint,
	revertIsolatedCadenceDrives,
	type SleepStageRecord,
	type StepPoint,
} from "../src/geo/biometrics.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment, TransportMode } from "../src/geo/segments.js";

function seg(startTs: number, endTs: number): TrackSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: 100,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 5,
	};
}

function hr(ts: number, bpm: number): HrPoint {
	return { ts, bpm };
}

function sleep(startTs: number, endTs: number, stage = "asleep"): SleepStageRecord {
	return { startTs, endTs, stage };
}

const HOUR = 3600;

describe("enrichSegmentWithBiometrics — missing data fallbacks", () => {
	it("returns nulls and sampleCount=0 when no HR data exists (e.g. Fitbit on charger)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], []);
		expect(r.hrMean).toBeNull();
		expect(r.hrMin).toBeNull();
		expect(r.hrMax).toBeNull();
		expect(r.hrStd).toBeNull();
		expect(r.sampleCount).toBe(0);
		expect(r.overlapsSleep).toBe(false);
		expect(r.sleepFraction).toBe(0);
	});

	it("works with HR but no sleep records (Fitbit recorded HR but no sleep that night)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [hr(60, 70), hr(120, 75), hr(180, 72)], []);
		expect(r.hrMean).not.toBeNull();
		expect(r.sampleCount).toBe(3);
		expect(r.overlapsSleep).toBe(false);
	});

	it("works with sleep records but no HR data (Fitbit died mid-day)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], [sleep(0, HOUR / 2)]);
		expect(r.hrMean).toBeNull();
		expect(r.sampleCount).toBe(0);
		expect(r.overlapsSleep).toBe(true);
		expect(r.sleepFraction).toBeCloseTo(0.5, 2);
	});

	it("ignores HR points outside the segment window", () => {
		// Segment 100..200; HR points at 50 (before), 150 (in), 250 (after)
		const r = enrichSegmentWithBiometrics(seg(100, 200), [hr(50, 60), hr(150, 80), hr(250, 90)], []);
		expect(r.sampleCount).toBe(1);
		expect(r.hrMean).toBe(80);
	});
});

describe("enrichSegmentWithBiometrics — HR statistics", () => {
	it("computes mean, min, max, std for HR in window", () => {
		// Constant 80 bpm → mean=80, std=0
		const r1 = enrichSegmentWithBiometrics(seg(0, 100), [hr(10, 80), hr(50, 80), hr(90, 80)], []);
		expect(r1.hrMean).toBe(80);
		expect(r1.hrMin).toBe(80);
		expect(r1.hrMax).toBe(80);
		expect(r1.hrStd).toBe(0);

		// Varying HR → non-zero std
		const r2 = enrichSegmentWithBiometrics(seg(0, 100), [hr(10, 60), hr(50, 80), hr(90, 100)], []);
		expect(r2.hrMean).toBe(80);
		expect(r2.hrMin).toBe(60);
		expect(r2.hrMax).toBe(100);
		expect(r2.hrStd).toBeGreaterThan(0);
	});
});

describe("enrichSegmentWithBiometrics — sleep overlap", () => {
	it("fully covers the segment → sleepFraction=1", () => {
		const r = enrichSegmentWithBiometrics(seg(100, 200), [], [sleep(50, 250)]);
		expect(r.overlapsSleep).toBe(true);
		expect(r.sleepFraction).toBe(1);
	});

	it("partial overlap (segment 100-200, sleep 150-250) → fraction=0.5", () => {
		const r = enrichSegmentWithBiometrics(seg(100, 200), [], [sleep(150, 250)]);
		expect(r.sleepFraction).toBeCloseTo(0.5, 2);
		expect(r.overlapsSleep).toBe(true);
	});

	it("multiple non-contiguous sleep stages sum correctly", () => {
		// Segment 0-1000; two sleep ranges 100-200 and 700-800 → 200/1000 = 0.2
		const r = enrichSegmentWithBiometrics(seg(0, 1000), [], [sleep(100, 200), sleep(700, 800)]);
		expect(r.sleepFraction).toBeCloseTo(0.2, 2);
	});

	it("no overlap when sleep is entirely outside segment", () => {
		const r = enrichSegmentWithBiometrics(seg(100, 200), [], [sleep(0, 50), sleep(300, 400)]);
		expect(r.overlapsSleep).toBe(false);
		expect(r.sleepFraction).toBe(0);
	});

	it("zero-duration segment doesn't divide by zero", () => {
		const r: BiometricEnrichment = enrichSegmentWithBiometrics(seg(100, 100), [], [sleep(100, 200)]);
		expect(r.sleepFraction).toBe(0);
	});
});

describe("enrichSegmentWithBiometrics — combined real-world cases", () => {
	it("overnight stay at home: HR steady ~55, sleep covers 100% of segment", () => {
		// 8 hour overnight stay
		const start = 0;
		const end = 8 * HOUR;
		const hrPoints: HrPoint[] = [];
		for (let t = start; t < end; t += 60) hrPoints.push(hr(t, 55 + Math.round(Math.random() * 4) - 2));
		const r = enrichSegmentWithBiometrics(seg(start, end), hrPoints, [sleep(start, end)]);
		expect(r.hrMean).toBeGreaterThan(50);
		expect(r.hrMean).toBeLessThan(60);
		expect(r.sleepFraction).toBe(1);
	});

	it("driving in a car as passenger: HR steady ~74, no sleep overlap", () => {
		const start = 0;
		const end = HOUR;
		const hrPoints = Array.from({ length: 20 }, (_, i) => hr(i * 180, 74 + (i % 3) - 1));
		const r = enrichSegmentWithBiometrics(seg(start, end), hrPoints, []);
		expect(r.hrMean).toBeCloseTo(74, 0);
		expect(r.overlapsSleep).toBe(false);
	});
});

describe("enrichSegmentWithBiometrics — step counts", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });

	it("returns null stepsTotal when no step rows are provided (e.g. Fitbit absent)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], [], []);
		expect(r.stepsTotal).toBeNull();
	});

	it("sums steps inside the segment window", () => {
		// 5 minutes, 100 steps each — 500 total inside the segment.
		const stepPoints: StepPoint[] = Array.from({ length: 5 }, (_, i) => step(i * 60, 100));
		const r = enrichSegmentWithBiometrics(seg(0, 5 * 60), [], [], stepPoints);
		expect(r.stepsTotal).toBe(500);
	});

	it("ignores step rows outside the segment window", () => {
		const stepPoints: StepPoint[] = [
			step(0, 50), // inside
			step(5 * HOUR, 1000), // outside (5h later)
		];
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], [], stepPoints);
		expect(r.stepsTotal).toBe(50);
	});

	it("treats zero overlap with same-day step rows as Fitbit-on, zero steps", () => {
		// User wore the Fitbit (we have step rows for the day) but the
		// segment in question saw no movement — distinguish from "no Fitbit".
		const stepPoints: StepPoint[] = [step(7 * HOUR, 200)]; // morning steps
		// Segment is later and quiet:
		const r = enrichSegmentWithBiometrics(seg(10 * HOUR, 11 * HOUR), [], [], stepPoints);
		expect(r.stepsTotal).toBe(0);
	});

	it("walking segment with steady cadence: ~80 steps/min for 10 min = 800", () => {
		const start = 0;
		const end = 10 * 60;
		const stepPoints: StepPoint[] = Array.from({ length: 10 }, (_, i) => step(i * 60, 80));
		const r = enrichSegmentWithBiometrics(seg(start, end), [], [], stepPoints);
		expect(r.stepsTotal).toBe(800);
	});
});

describe("cadenceForSegment", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });

	it("returns 0 for an empty step array", () => {
		expect(cadenceForSegment(seg(0, HOUR), [])).toBe(0);
	});

	it("returns steps-per-minute over the segment duration", () => {
		// 10 minutes, 80 steps each minute → 800 / 10 = 80 steps/min
		const points = Array.from({ length: 10 }, (_, i) => step(i * 60, 80));
		expect(cadenceForSegment(seg(0, 10 * 60), points)).toBeCloseTo(80, 0);
	});

	it("ignores step rows outside the segment", () => {
		const points = [step(0, 100), step(7 * HOUR, 200)];
		// Segment 1m → 100 steps total, 100 steps/min
		expect(cadenceForSegment(seg(0, 60), points)).toBeCloseTo(100, 0);
	});

	it("returns 0 for very short segments (no minutes to average over)", () => {
		// segment <30s — denominator would be tiny and we'd amplify any noise
		const points = [step(0, 5)];
		expect(cadenceForSegment(seg(0, 20), points)).toBe(0);
	});
});

describe("correctModeFromCadence — passenger-in-traffic detection", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });
	type SegLike = TrackSegment & { refinedMode?: TransportMode; refinedReason?: string };
	const baseSeg = (mode: "walking" | "driving" | "stationary", avgSpeed: number, durationS: number): SegLike => ({
		startTs: 0,
		endTs: durationS,
		mode,
		confidence: 1,
		confidenceMargin: 100,
		avgSpeed,
		maxSpeed: avgSpeed * 1.2,
		linearity: 0.5,
		pointCount: 5,
	});

	it("re-labels walking → driving when cadence is near zero (passenger in slow traffic)", () => {
		// 4 km/h "walking" with no steps for 5 minutes → not actually walking.
		const seg = baseSeg("walking", 4, 5 * 60);
		const r = correctModeFromCadence(seg, []); // no step rows → fall through to "no Fitbit"
		// With no data, must NOT correct (no cadence info to act on).
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("re-labels walking → driving when cadence is near zero AND Fitbit data is fresh", () => {
		// Fitbit was on AND data has been pulled past the segment's end
		// (a step row exists shortly after) — but the segment itself has
		// no steps → user was a passenger.
		const seg = baseSeg("walking", 4, 5 * 60);
		// Step row 10 min after segment end → satisfies freshness guard.
		const stepsThisDay: StepPoint[] = [step(5 * 60 + 10 * 60, 100)];
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode).toBe("driving");
		expect(r.refinedReason).toMatch(/cadence/i);
		// The machine-readable tag — what `revertIsolatedCadenceDrives` branches
		// on — must be set, not just the human-readable reason.
		expect(r.refinedKinds).toContain("low-cadence");
	});

	it("does NOT correct when step data is stale (no rows past segment end — sync hasn'''t caught up)", () => {
		// Real regression: walked home at 22:30; segment ended 22:45. Latest
		// Fitbit step sync only reaches 19:04, hours behind. With the old
		// code, zero cadence in window triggered driving-correction even
		// though we simply hadn't pulled the relevant minutes from Fitbit
		// yet. The freshness guard requires a step row within 30 min after
		// the segment end before applying the correction.
		const seg = baseSeg("walking", 4, 5 * 60);
		// Step rows BEFORE the segment exist (Fitbit was on earlier today)
		// but no rows AFTER the segment end → freshness guard blocks.
		const stepsThisDay: StepPoint[] = [step(0, 50)];
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("keeps walking when cadence is in the walking range (80–120/min)", () => {
		const seg = baseSeg("walking", 4, 5 * 60);
		// 90 steps/min × 5 min = 450 steps in segment
		const stepsThisDay: StepPoint[] = Array.from({ length: 5 }, (_, i) => step(i * 60, 90));
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("keeps walking for slow / interrupted urban walking (~25–40 steps/min)", () => {
		// Regression: a real urban walk with frequent stops (window-shopping,
		// crossings, queues) reads ~27 steps/min over 10 min = 270 steps.
		// Must not be falsely corrected to driving — better to under-correct
		// than to corrupt a real walking segment.
		const seg = baseSeg("walking", 3, 10 * 60);
		const stepsThisDay: StepPoint[] = Array.from({ length: 10 }, (_, i) => step(i * 60, 27));
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("does NOT correct very short segments (insufficient cadence sample)", () => {
		// 1-min walking with no steps could be a brief pause; don't over-react.
		const seg = baseSeg("walking", 4, 60);
		const stepsThisDay: StepPoint[] = [step(7 * HOUR, 100)];
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("does NOT correct walking at high speed (already implausible as walking)", () => {
		// If avgSpeed > 15 km/h, the segment classifier would already prefer
		// cycling/driving — cadence correction shouldn't override.
		const seg = baseSeg("walking", 25, 5 * 60);
		const r = correctModeFromCadence(seg, [step(7 * HOUR, 100)]);
		expect(r.refinedMode ?? r.mode).toBe("walking"); // unchanged
	});

	it("leaves driving / stationary segments alone (this pass only fixes walking)", () => {
		const driving = baseSeg("driving", 50, 5 * 60);
		const stationary = baseSeg("stationary", 0, 5 * 60);
		expect(correctModeFromCadence(driving, []).refinedMode ?? "driving").toBe("driving");
		expect(correctModeFromCadence(stationary, []).refinedMode ?? "stationary").toBe("stationary");
	});

	it("preserves an existing refinedReason in the corrected segment", () => {
		const seg = { ...baseSeg("walking", 4, 5 * 60), refinedReason: "near tertiary" };
		// Fresh step row after segment end so the freshness guard passes.
		const r = correctModeFromCadence(seg, [step(5 * 60 + 600, 100)]);
		expect(r.refinedMode).toBe("driving");
		expect(r.refinedReason).toMatch(/near tertiary/);
		expect(r.refinedReason).toMatch(/cadence/i);
	});
});

describe("correctModeFromCadence — stationary walk-through detection (2026-05-25 Union Park)", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });
	type SegLike = TrackSegment & { refinedMode?: TransportMode; refinedReason?: string };
	const stationarySeg = (avgSpeed: number, durationS: number): SegLike => ({
		startTs: 0,
		endTs: durationS,
		mode: "stationary",
		confidence: 0.9,
		confidenceMargin: 100,
		avgSpeed,
		maxSpeed: Math.max(avgSpeed * 1.2, 5),
		linearity: 0.1,
		pointCount: 5,
	});

	it("flips stationary → walking on a walking burst WITH GPS translation (Union Park: peak 104/min, avg 1.4 km/h)", () => {
		// Ground truth: walked through Union Park (a park, not a stop); the
		// slow, meandering pace made the GPS classifier score it stationary.
		// The watch recorded a 104-steps/min minute mid-window.
		const seg = stationarySeg(1.4, 5 * 60);
		const steps: StepPoint[] = [step(0, 8), step(60, 18), step(120, 104), step(180, 12), step(240, 0)];
		const r = correctStationaryWalkThrough(seg, steps);
		expect(r.refinedMode).toBe("walking");
		expect(r.refinedReason).toMatch(/walk/i);
	});

	it("does NOT flip in-place pacing at an established stay (same step burst, ~0 GPS translation)", () => {
		// Pacing across a room at home / a hospital ward: identical 104/min
		// burst, but the GPS shows no translation (avg 0.1 km/h) → a real stay.
		const seg = stationarySeg(0.1, 5 * 60);
		const steps: StepPoint[] = [step(0, 8), step(60, 18), step(120, 104), step(180, 12), step(240, 0)];
		const r = correctStationaryWalkThrough(seg, steps);
		expect(r.refinedMode ?? r.mode).toBe("stationary");
	});

	it("does NOT flip a drifting stop without a clear walking burst (GPS translation but low peak cadence)", () => {
		// Slow GPS drift around a stop with incidental shuffling (peak 30/min):
		// translation present, but no unmistakable walking minute → stay put.
		const seg = stationarySeg(1.4, 5 * 60);
		const steps: StepPoint[] = [step(0, 10), step(60, 30), step(120, 20), step(180, 15), step(240, 5)];
		const r = correctStationaryWalkThrough(seg, steps);
		expect(r.refinedMode ?? r.mode).toBe("stationary");
	});

	it("does NOT flip a too-short stationary blip even with a burst (insufficient sample)", () => {
		const seg = stationarySeg(1.4, 60);
		const steps: StepPoint[] = [step(0, 104)];
		const r = correctStationaryWalkThrough(seg, steps);
		expect(r.refinedMode ?? r.mode).toBe("stationary");
	});

	it("does NOT flip when there is no step data at all", () => {
		const seg = stationarySeg(1.4, 5 * 60);
		const r = correctStationaryWalkThrough(seg, []);
		expect(r.refinedMode ?? r.mode).toBe("stationary");
	});

	// Geometry veto: a long dwell whose fixes go nowhere is a stay, even when
	// jitter inflates avgSpeed past the translation threshold and a step burst
	// fires. The 2026-06-17 Bloomsbury Surgery appointment: 15 min within ~45 m,
	// erased into a phantom walk before this guard.
	const clusteredFixes = (n: number, spreadDeg: number): FilteredPoint[] =>
		Array.from({ length: n }, (_, i) => {
			const j = ((i * 37) % 11) - 5; // deterministic -5..5 wobble
			return {
				ts: i * 30,
				lat: 51.5256 + j * spreadDeg,
				lon: -0.1231 + j * spreadDeg,
				speed_kmh: i % 5 === 0 ? 5 : 1,
				bearing: 0,
			};
		});

	it("does NOT flip a long, geometrically-tight dwell despite a walking burst (the GP appointment)", () => {
		const seg = stationarySeg(1.5, 15 * 60); // avgSpeed 1.5 > 1.0 → clears the old guard
		const burst: StepPoint[] = [step(0, 8), step(120, 95), step(300, 12), step(600, 0), step(840, 5)];
		const pts = clusteredFixes(30, 0.00007); // ~±39 m, extent < 80 m
		const r = correctStationaryWalkThrough(seg, burst, pts);
		expect(r.refinedMode ?? r.mode).toBe("stationary");
	});

	it("STILL flips a long walk-through whose fixes actually cover ground (extent > 80 m)", () => {
		const seg = stationarySeg(1.5, 15 * 60);
		const burst: StepPoint[] = [step(0, 8), step(120, 95), step(300, 90), step(600, 88), step(840, 80)];
		// 30 fixes progressing ~330 m — a real walk the GPS scored stationary.
		const pts: FilteredPoint[] = Array.from({ length: 30 }, (_, i) => ({
			ts: i * 30,
			lat: 51.52 + i * 0.0001,
			lon: -0.12,
			speed_kmh: 3,
			bearing: 0,
		}));
		const r = correctStationaryWalkThrough(seg, burst, pts);
		expect(r.refinedMode).toBe("walking");
	});

	it("NEVER flips a multi-hour stationary segment — walk-throughs are minutes-scale", () => {
		// The phantom-afternoon class: a 3.5 h office stay whose merged window
		// picked up a short errand's fixes (busting the tight-extent veto) and
		// its step burst (supplying the peak cadence). Every per-minute guard
		// passes — but relabelling HOURS of dwell as one walk off a single
		// walking burst is structurally absurd. If a long stay truly hides a
		// walk, the carve passes own splitting it out; this pass only flips
		// whole short stops.
		const seg = stationarySeg(1.5, 202 * 60);
		const burst: StepPoint[] = [step(0, 8), step(5700, 95), step(5760, 90), step(5820, 88), step(11_000, 5)];
		// Fixes mostly in one tight cluster, plus an errand excursion past the
		// 80 m extent veto — the polluted-merge shape.
		const pts: FilteredPoint[] = [
			...clusteredFixes(40, 0.00007),
			...Array.from({ length: 10 }, (_, i) => ({
				ts: 5700 + i * 60,
				lat: 51.5256 + 0.0012, // ~130 m north — extent > 80 m
				lon: -0.1231,
				speed_kmh: 4,
				bearing: 0,
			})),
		];
		const r = correctStationaryWalkThrough(seg, burst, pts);
		expect(r.refinedMode ?? r.mode).toBe("stationary");
	});

	it("does not apply the geometry veto to a short walk-through (5-min Union Park still flips)", () => {
		// Same tight cluster, but only 5 min — under the long-dwell threshold,
		// so the veto stays out of the way and the burst flips it.
		const seg = stationarySeg(1.4, 5 * 60);
		const steps: StepPoint[] = [step(0, 8), step(60, 18), step(120, 104), step(180, 12), step(240, 0)];
		const pts = clusteredFixes(10, 0.00007);
		const r = correctStationaryWalkThrough(seg, steps, pts);
		expect(r.refinedMode).toBe("walking");
	});
});

describe("applyStationaryWalkThrough — sequence-level guards", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });
	type Seg = TrackSegment & { refinedMode?: TransportMode; refinedReason?: string; place?: string; wayName?: string };
	const stat = (startTs: number, endTs: number, avgSpeed: number, place?: string): Seg => ({
		startTs,
		endTs,
		mode: "stationary",
		confidence: 0.9,
		confidenceMargin: 100,
		avgSpeed,
		maxSpeed: Math.max(avgSpeed * 1.2, 5),
		linearity: 0.1,
		pointCount: 5,
		place,
	});
	const walk = (startTs: number, endTs: number, wayName?: string): Seg => ({
		startTs,
		endTs,
		mode: "walking",
		confidence: 0.9,
		confidenceMargin: 100,
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.5,
		pointCount: 5,
		wayName,
	});
	// A clear walking burst with GPS translation in 0..300s.
	const burst: StepPoint[] = [step(0, 8), step(60, 18), step(120, 104), step(180, 12), step(240, 0)];

	it("flips a standalone phantom stop AND merges it into the adjacent walk (Union Park → Hudson Walk)", () => {
		const segs = [walk(0, 600, "Hudson Walk"), stat(600, 900, 1.4, "Union Park (park)"), walk(900, 1200)];
		// Burst lands inside the stationary segment 600..900.
		const steps = [step(660, 8), step(720, 18), step(780, 104), step(840, 12)];
		const out = applyStationaryWalkThrough(segs, steps);
		// All three collapse into a single walking run keeping the real wayName.
		expect(out).toHaveLength(1);
		expect(out[0].refinedMode ?? out[0].mode).toBe("walking");
		expect(out[0].wayName).toBe("Hudson Walk");
		expect(out[0].place).toBeUndefined();
		expect(out[0].startTs).toBe(0);
		expect(out[0].endTs).toBe(1200);
	});

	it("does NOT flip a stop bracketed by the SAME place (intra-Work pacing to the bathroom and back)", () => {
		const segs = [stat(0, 600, 0, "Work"), stat(600, 900, 1.4, "Work"), stat(900, 1500, 0, "Work")];
		const out = applyStationaryWalkThrough(
			segs,
			burst.map((p) => step(p.ts + 600, p.steps)),
		);
		// The middle stop is intra-place movement → stays stationary.
		expect(out.every((s) => (s.refinedMode ?? s.mode) === "stationary")).toBe(true);
	});

	it("DOES flip a stop that transitions between two DIFFERENT places", () => {
		const segs = [stat(0, 600, 0, "Varley"), stat(600, 900, 1.4, "Union Park (park)"), stat(900, 1500, 0, "Home")];
		const steps = [step(660, 8), step(720, 104), step(780, 90)];
		const out = applyStationaryWalkThrough(segs, steps);
		const middle = out.find((s) => s.startTs === 600);
		expect(middle?.refinedMode).toBe("walking");
	});

	it("never merges two non-walking segments (trains stay distinct)", () => {
		const train = (startTs: number, endTs: number, wayName: string): Seg => ({
			...walk(startTs, endTs, wayName),
			mode: "train",
			refinedMode: "train",
			avgSpeed: 40,
			maxSpeed: 60,
		});
		const segs = [train(0, 600, "Met line"), train(600, 1200, "Jubilee line")];
		const out = applyStationaryWalkThrough(segs, burst);
		expect(out).toHaveLength(2);
		expect(out.map((s) => s.wayName)).toEqual(["Met line", "Jubilee line"]);
	});
});

describe("revertIsolatedCadenceDrives — undo a cadence flip with no vehicular context", () => {
	type SegLike = TrackSegment & { refinedMode?: TransportMode; refinedReason?: string };
	let ts = 0;
	const span = (mode: SegLike["mode"], durS: number, avg: number, max: number): SegLike => {
		const s: SegLike = {
			startTs: ts,
			endTs: ts + durS,
			mode,
			confidence: 1,
			confidenceMargin: 100,
			avgSpeed: avg,
			maxSpeed: max,
			linearity: 0.5,
			pointCount: 5,
		};
		ts += durS;
		return s;
	};
	// A segment the cadence pass flipped walking -> driving: base mode stays
	// "walking", refinedMode is "driving", tagged with the low-cadence kind.
	const flip = (durS: number, avg: number, max: number): SegLike => ({
		...span("walking", durS, avg, max),
		refinedMode: "driving",
		refinedReason: "low cadence (0/min)",
		refinedKinds: ["low-cadence"],
	});
	const walking = (durS: number) => span("walking", durS, 4, 7);
	const stay = (durS: number) => span("stationary", durS, 0.2, 1);
	const realDrive = (durS: number) => {
		const s = span("driving", durS, 35, 60);
		s.refinedMode = "driving";
		return s;
	};
	const eff = (s: SegLike) => s.refinedMode ?? s.mode;

	it("reverts a lone pedestrian-paced flip bracketed by walking", () => {
		ts = 0;
		const out = revertIsolatedCadenceDrives([walking(600), flip(5 * 60, 3, 12), walking(600)]);
		expect(eff(out[1])).toBe("walking");
		expect(out[1].refinedReason).toMatch(/no adjacent driving/i);
	});

	it("reverts a flip bracketed by pedestrian stays (skips stationary to find real neighbours)", () => {
		ts = 0;
		const out = revertIsolatedCadenceDrives([walking(600), stay(300), flip(5 * 60, 3, 12), stay(300), walking(600)]);
		expect(eff(out[2])).toBe("walking");
	});

	it("reverts ALL flips in a pottering-about run (flips don't count as each other's drive context)", () => {
		ts = 0;
		// walk · stay · flip · stay · flip · stay · flip · stay · walk
		const out = revertIsolatedCadenceDrives([
			walking(600),
			stay(300),
			flip(300, 3, 13),
			stay(300),
			flip(23 * 60, 2.6, 12.6),
			stay(900),
			flip(900, 2.7, 11.6),
			stay(300),
			walking(480),
		]);
		expect([out[2], out[4], out[6]].map(eff)).toEqual(["walking", "walking", "walking"]);
	});

	it("KEEPS a flip adjacent to a real GPS drive (the absorb-into-drive case it was built for)", () => {
		ts = 0;
		const out = revertIsolatedCadenceDrives([realDrive(600), flip(5 * 60, 5, 14), walking(600)]);
		expect(eff(out[1])).toBe("driving");
	});

	it("KEEPS a flip whose real drive neighbour is one stationary away (traffic-light stop)", () => {
		ts = 0;
		const out = revertIsolatedCadenceDrives([realDrive(600), stay(120), flip(5 * 60, 5, 14), walking(600)]);
		expect(eff(out[2])).toBe("driving");
	});

	it("does NOT revert a vehicular-average flip even when isolated (only pedestrian-paced reverts)", () => {
		ts = 0;
		const out = revertIsolatedCadenceDrives([walking(600), flip(5 * 60, 12, 14), walking(600)]);
		expect(eff(out[1])).toBe("driving");
	});

	it("leaves a GPS-classified driving segment alone (only touches cadence flips)", () => {
		ts = 0;
		const gpsDrive = span("driving", 5 * 60, 3, 12);
		gpsDrive.refinedMode = "driving";
		const out = revertIsolatedCadenceDrives([walking(600), gpsDrive, walking(600)]);
		expect(eff(out[1])).toBe("driving");
	});
});

describe("demoteJitterWalkToStationary — a 0-step jittery 'walk' is really sitting still", () => {
	type SegLike = TrackSegment & { refinedMode?: TransportMode; refinedReason?: string };
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });
	// freshness: a step row shortly after the segment end proves Fitbit synced.
	const fresh = (endTs: number): StepPoint[] => [step(endTs + 5 * 60, 50)];
	const mk = (over: Partial<SegLike>): SegLike => ({
		startTs: 0,
		endTs: 23 * 60,
		mode: "walking",
		confidence: 1,
		confidenceMargin: 100,
		avgSpeed: 2.6,
		maxSpeed: 12.6,
		linearity: 0.15,
		pointCount: 30,
		...over,
	});
	const eff = (s: SegLike) => s.refinedMode ?? s.mode;

	it("demotes the Olivomare-style fragment: peak≈0 steps, low linearity, fresh data", () => {
		const seg = mk({});
		const r = demoteJitterWalkToStationary(seg, fresh(seg.endTs));
		expect(eff(r)).toBe("stationary");
		expect(r.refinedReason).toMatch(/jitter|sitting/i);
		// `planJitterStayRuns` groups co-located fragments by this tag.
		expect(r.refinedKinds).toContain("gps-jitter");
	});

	it("KEEPS a directed walk where Fitbit merely missed the steps (high linearity)", () => {
		const seg = mk({ linearity: 0.8 });
		expect(eff(demoteJitterWalkToStationary(seg, fresh(seg.endTs)))).toBe("walking");
	});

	it("KEEPS a real walk that has at least one clear walking minute (peak cadence high)", () => {
		const seg = mk({});
		const steps = [...fresh(seg.endTs), step(10 * 60, 95)]; // one 95-step minute inside
		expect(eff(demoteJitterWalkToStationary(seg, steps))).toBe("walking");
	});

	it("does NOT demote when Fitbit data is stale (no step row after the segment)", () => {
		const seg = mk({});
		expect(eff(demoteJitterWalkToStationary(seg, [step(0, 50)]))).toBe("walking");
	});

	it("does NOT demote a short segment (insufficient sample)", () => {
		const seg = mk({ endTs: 90 });
		expect(eff(demoteJitterWalkToStationary(seg, fresh(seg.endTs)))).toBe("walking");
	});

	it("leaves non-walking segments alone", () => {
		const driving = mk({ mode: "driving", refinedMode: "driving" });
		expect(eff(demoteJitterWalkToStationary(driving, fresh(driving.endTs)))).toBe("driving");
	});

	it("conservative on missing Fitbit data (no step rows at all)", () => {
		const seg = mk({});
		expect(eff(demoteJitterWalkToStationary(seg, []))).toBe("walking");
	});
});
