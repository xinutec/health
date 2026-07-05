import { describe, expect, it } from "vitest";
import {
	bearingDeg,
	circularDiffDeg,
	compareHeadings,
	type MotionSample,
	summarizeDiffs,
	type TrackSample,
} from "../src/eval/heading-eval.js";

// ~51.5°N: 1e-4 lat ≈ 11.1 m north; 1e-4 lon ≈ 6.9 m east.
const LAT = 51.5;
const LON = -0.3;

function track(hops: Array<{ dLat: number; dLon: number }>, stepS = 10): TrackSample[] {
	const out: TrackSample[] = [{ ts: 1_000_000, lat: LAT, lon: LON }];
	for (const h of hops) {
		const prev = out[out.length - 1];
		out.push({ ts: prev.ts + stepS, lat: prev.lat + h.dLat, lon: prev.lon + h.dLon });
	}
	return out;
}

function motion(ts: number, cogDeg: number | null, velKmh: number | null = 4): MotionSample {
	return { ts, cogDeg, velKmh };
}

describe("circularDiffDeg", () => {
	it("wraps across north", () => {
		expect(circularDiffDeg(350, 10)).toBeCloseTo(20);
		expect(circularDiffDeg(10, 350)).toBeCloseTo(20);
	});
	it("handles the antipode and identity", () => {
		expect(circularDiffDeg(0, 180)).toBeCloseTo(180);
		expect(circularDiffDeg(90, 90)).toBeCloseTo(0);
	});
});

describe("bearingDeg", () => {
	it("points north and east for small offsets", () => {
		expect(bearingDeg({ lat: LAT, lon: LON }, { lat: LAT + 1e-4, lon: LON })).toBeCloseTo(0, 0);
		expect(bearingDeg({ lat: LAT, lon: LON }, { lat: LAT, lon: LON + 1e-4 })).toBeCloseTo(90, 0);
	});
});

describe("compareHeadings", () => {
	it("matches phone cog against the GPS hop course, joined by ts", () => {
		// Two eastward hops (~14 m each); phone reports cog 90 at each hop start.
		const t = track([
			{ dLat: 0, dLon: 2e-4 },
			{ dLat: 0, dLon: 2e-4 },
		]);
		const m = [motion(1_000_000, 90), motion(1_000_010, 90)];
		const cmp = compareHeadings(t, m);
		expect(cmp).toHaveLength(2);
		for (const c of cmp) expect(c.diffDeg).toBeLessThan(2);
	});

	it("skips hops with no cog, a stationary phone, or no nearby motion sample", () => {
		const t = track([
			{ dLat: 0, dLon: 2e-4 },
			{ dLat: 0, dLon: 2e-4 },
			{ dLat: 0, dLon: 2e-4 },
		]);
		const m = [
			motion(1_000_000, null), // no heading reported
			motion(1_000_010, 90, 0.5), // below the moving threshold
			// third hop: nothing within the join tolerance
		];
		expect(compareHeadings(t, m)).toHaveLength(0);
	});

	it("joins a motion sample within the tolerance but not beyond it", () => {
		const t = track([{ dLat: 0, dLon: 2e-4 }]);
		expect(compareHeadings(t, [motion(1_000_002, 90)])).toHaveLength(1);
		expect(compareHeadings(t, [motion(1_000_007, 90)])).toHaveLength(0);
	});

	it("skips hops too short to define a GPS course (jitter at a standstill)", () => {
		// ~1.4 m hop — under the minimum hop length.
		const t = track([{ dLat: 0, dLon: 0.2e-4 }]);
		expect(compareHeadings(t, [motion(1_000_000, 90)])).toHaveLength(0);
	});

	it("reports the wrapped difference", () => {
		// Northward hop, phone says 350° → diff 10°, not 350°.
		const t = track([{ dLat: 2e-4, dLon: 0 }]);
		const cmp = compareHeadings(t, [motion(1_000_000, 350)]);
		expect(cmp).toHaveLength(1);
		expect(cmp[0].diffDeg).toBeCloseTo(10, 0);
	});
});

describe("summarizeDiffs", () => {
	it("returns n, median and p90", () => {
		const s = summarizeDiffs([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
		expect(s.n).toBe(10);
		expect(s.medianDeg).toBeCloseTo(45);
		expect(s.p90Deg).toBeCloseTo(81);
	});
	it("is honest about an empty set", () => {
		const s = summarizeDiffs([]);
		expect(s.n).toBe(0);
		expect(s.medianDeg).toBeNull();
		expect(s.p90Deg).toBeNull();
	});
});
