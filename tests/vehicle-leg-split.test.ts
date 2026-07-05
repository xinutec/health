import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment } from "../src/geo/segments.js";
import { splitWalksOnVehicleLeg } from "../src/geo/stay-split.js";

// Synthetic, abstract scenarios — no real journey data. Movement is in
// latitude only; ~111,195 m per degree, so `at(m)` places a fix m metres
// north of a fixed origin.
const ORIGIN = 51.0;
const at = (m: number): number => ORIGIN + m / 111195;

function fix(ts: number, lat: number, speed_kmh: number, lon = 0): FilteredPoint {
	return { ts, lat, lon, speed_kmh, bearing: 0 };
}
function walk(startTs: number, endTs: number, mode = "walking"): TrackSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 0.5,
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.5,
		pointCount: 0,
	} as TrackSegment;
}

describe("splitWalksOnVehicleLeg", () => {
	it("carves a vehicle ride out of a walk → [walk, driving, walk]", () => {
		// 4 min loitering at the origin, then ~1.7 km covered in 3 min at
		// 30 km/h, then arrival.
		const pts = [
			fix(0, at(0), 3),
			fix(60, at(10), 3),
			fix(120, at(0), 3),
			fix(180, at(8), 3),
			fix(240, at(0), 3),
			fix(300, at(556), 30),
			fix(360, at(1112), 30),
			fix(420, at(1668), 30),
			fix(480, at(1670), 3),
			fix(540, at(1668), 3),
			fix(600, at(1672), 3),
		];
		const out = splitWalksOnVehicleLeg([walk(0, 600)], pts);
		expect(out.map((s) => s.mode)).toEqual(["walking", "driving", "walking"]);
		const drive = out[1];
		expect(drive.startTs).toBe(240);
		expect(drive.endTs).toBe(420);
		expect(drive.maxSpeed).toBeGreaterThanOrEqual(20);
		// boundaries are contiguous and cover the whole original window
		expect(out[0].startTs).toBe(0);
		expect(out[2].endTs).toBe(600);
	});

	it("does NOT split a stationary wait with jittery high-speed readings", () => {
		// The platform-wait case: GPS reports 19–23 km/h but the position
		// never leaves a ~20 m cluster, so there is no net progress.
		const pts = [
			fix(0, at(0), 22),
			fix(60, at(15), 20),
			fix(120, at(-10), 21),
			fix(180, at(8), 23),
			fix(240, at(-12), 19),
			fix(300, at(5), 22),
			fix(360, at(10), 20),
			fix(420, at(-8), 21),
			fix(480, at(3), 22),
			fix(540, at(12), 19),
			fix(600, at(0), 20),
		];
		const out = splitWalksOnVehicleLeg([walk(0, 600)], pts);
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("walking");
	});

	it("does NOT split a slow walk with a single GPS speed spike", () => {
		const pts = Array.from({ length: 11 }, (_, i) => fix(i * 60, at((i * 600) / 10), i === 5 ? 50 : 4));
		const out = splitWalksOnVehicleLeg([walk(0, 600)], pts);
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("walking");
	});

	it("reclassifies a whole walk that is really one continuous ride", () => {
		const pts = Array.from({ length: 6 }, (_, i) => fix(i * 60, at((i * 1668) / 5), 25));
		const out = splitWalksOnVehicleLeg([walk(0, 300)], pts);
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("driving");
		expect(out[0].startTs).toBe(0);
		expect(out[0].endTs).toBe(300);
	});

	it("leaves a genuine slow walk untouched", () => {
		const pts = Array.from({ length: 11 }, (_, i) => fix(i * 60, at((i * 600) / 10), 4));
		const out = splitWalksOnVehicleLeg([walk(0, 600)], pts);
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("walking");
	});

	it("does not carve the train-boarding bleed at a walk→train boundary", () => {
		// A real walk whose last fixes accelerate as the next train pulls
		// away — that fast tail is the train bleeding into the walk, not a
		// separate ride. Guarded because the next segment is a train.
		const pts = [
			fix(0, at(0), 4),
			fix(60, at(60), 4),
			fix(120, at(130), 5),
			fix(180, at(210), 5),
			fix(240, at(290), 6),
			fix(300, at(720), 48),
			fix(360, at(1320), 60),
		];
		const out = splitWalksOnVehicleLeg([walk(0, 360), walk(360, 1200, "train")], pts);
		expect(out).toHaveLength(2);
		expect(out[0].mode).toBe("walking");
		expect(out[1].mode).toBe("train");
	});

	it("ignores non-walking segments", () => {
		const drive = walk(0, 300, "driving");
		const pts = Array.from({ length: 6 }, (_, i) => fix(i * 60, at((i * 1668) / 5), 25));
		const out = splitWalksOnVehicleLeg([drive], pts);
		expect(out).toEqual([drive]);
	});
});
