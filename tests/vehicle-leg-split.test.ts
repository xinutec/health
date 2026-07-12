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

	// 2026-05-25 12:41–12:55, a user-confirmed car ride home on Fulton Road.
	//
	// A short urban car ride averages low — traffic, lights, a 14-minute crawl —
	// so the segmenter's raw `mode` is "walking". OSM refinement then correctly
	// identified it: `refinedMode: "driving"`, on Fulton Road. But this pass gated
	// on the RAW mode, so it went looking for a ride hidden inside a segment the
	// pipeline had already concluded WAS a ride, and carved the confirmed drive
	// into a walk plus a 3-minute drive.
	//
	// It went unnoticed only because the remainders used to inherit the parent's
	// `refinedMode: "driving"`, so both halves still rendered as driving. Once a
	// remainder gets its own honest kinematics, the bad carve shows: a 10-minute
	// stretch of a confirmed car ride re-derived as "walking on Fulton Road".
	//
	// This pass is for "a walking segment that actually contains a short ride".
	// If refinement already says driving, it is not a walk hiding a ride — it is
	// the ride, and must be left alone.
	it("does not carve a segment refinement has already identified as a vehicle", () => {
		const ride = {
			...walk(0, 840),
			refinedMode: "driving",
			wayName: "Fulton Road",
		} as TrackSegment;
		// Slow crawl, then a clear run — the shape that tempts the carve.
		const pts = [
			fix(0, at(0), 4),
			fix(120, at(100), 6),
			fix(240, at(200), 5),
			fix(360, at(300), 4),
			fix(480, at(900), 32),
			fix(600, at(1500), 36),
			fix(720, at(2100), 34),
			fix(840, at(2200), 5),
		];
		const out = splitWalksOnVehicleLeg([ride], pts);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual(ride);
	});

	// The 2026-07-12 bug. A single "walking" segment spanned an entire tube ride
	// (King's Cross → Highbury & Islington): the fixes cut out underground, so
	// segmentation glued the walk *to* the station, the ride, and the walk *from*
	// the station into one row. Its summary statistics were therefore measured
	// across the ride — 1047 m of linear progress peaking at 64 km/h — and OSM
	// named it by sampling a line drawn through that ride, landing on Euston Road.
	//
	// The carve correctly recovers the ride. But the two walk remainders were
	// emitted as `{...seg}` with only the timestamps touched, so BOTH inherited
	// the parent's cross-ride speed, linearity and street name. The result was two
	// rows claiming to be walks at a peak of 64 km/h — the Underground's speed —
	// on a road neither of them was anywhere near. The second was 4 km away.
	//
	// A remainder's statistics must describe the remainder, and enrichment derived
	// from the parent's window is not evidence about it.
	describe("walk remainders after the carve", () => {
		// 3 min on foot, a 3 min ride covering ~1.7 km at 34 km/h, 3 min on foot.
		const pts = [
			fix(0, at(0), 3),
			fix(60, at(50), 4),
			fix(120, at(100), 3),
			fix(180, at(150), 4),
			fix(240, at(720), 34),
			fix(300, at(1290), 64),
			fix(360, at(1860), 34),
			fix(420, at(1910), 4),
			fix(480, at(1960), 3),
			fix(540, at(2010), 4),
			fix(600, at(2060), 3),
		];
		// The parent's own summary — measured across the ride it unknowingly spans.
		const parent = {
			...walk(0, 600),
			avgSpeed: 2.3,
			maxSpeed: 64,
			linearity: 0.89,
			wayName: "Euston Road",
			place: "King's Cross",
			refinedReason: "stationary-coherence override (linear 1047 m progress)",
		} as TrackSegment;

		it("gives each remainder its own kinematics, not the parent's", () => {
			const out = splitWalksOnVehicleLeg([parent], pts);
			expect(out.map((s) => s.mode)).toEqual(["walking", "driving", "walking"]);
			const [before, , after] = out;
			// The tube's 64 km/h must not survive on a segment we call walking —
			// the walking veto (#176) exists to reject exactly this, and it was
			// being fed the ride's peak as if it were the walk's.
			expect(before.maxSpeed).toBeLessThan(12);
			expect(after.maxSpeed).toBeLessThan(12);
			// …nor the ride's linear progress.
			expect(before.linearity).not.toBe(0.89);
			expect(after.linearity).not.toBe(0.89);
		});

		it("drops enrichment the parent derived from a window spanning the ride", () => {
			const out = splitWalksOnVehicleLeg([parent], pts);
			const [before, , after] = out;
			for (const s of [before, after]) {
				const e = s as TrackSegment & { wayName?: string; place?: string; refinedReason?: string };
				expect(e.wayName).toBeUndefined();
				expect(e.place).toBeUndefined();
				expect(e.refinedReason).toBeUndefined();
			}
		});
	});
});
