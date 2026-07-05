import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment } from "../src/geo/segments.js";
import { reassignWalkTailToVehicle } from "../src/geo/stay-split.js";

// Synthetic scenarios. Movement is in latitude only; ~111,195 m per degree,
// so `at(m)` places a fix m metres north of a fixed origin.
const ORIGIN = 51.0;
const at = (m: number): number => ORIGIN + m / 111195;

function fix(ts: number, lat: number, speed_kmh: number, lon = 0): FilteredPoint {
	return { ts, lat, lon, speed_kmh, bearing: 0 };
}
function seg(startTs: number, endTs: number, mode = "walking"): TrackSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 0.5,
		avgSpeed: mode === "walking" ? 4 : 25,
		maxSpeed: mode === "walking" ? 27 : 30,
		linearity: 0.5,
		pointCount: 0,
	} as TrackSegment;
}

const maxStep = (pts: readonly FilteredPoint[], from: number, to: number): number => {
	let m = 0;
	for (let i = 1; i < pts.length; i++) {
		const p = pts[i];
		const q = pts[i - 1];
		if (p.ts <= from || p.ts > to) continue;
		const dt = p.ts - q.ts;
		const dm = Math.abs(p.lat - q.lat) * 111195;
		if (dt > 0) m = Math.max(m, (dm / dt) * 3.6);
	}
	return m;
};

describe("reassignWalkTailToVehicle", () => {
	// The 2026-06-21 morning bug: a walking segment whose last fixes are the
	// first seconds of the drive that follows it. Segmentation glued the
	// vehicle-paced launch into the walk; the median speed hid it, so the
	// whole leg stayed "walking" and the map drew a 24 km/h walk. The next
	// segment is already a confirmed drive, so those tail fixes belong to it.
	it("moves a vehicle-paced trailing run into the following drive", () => {
		const pts = [
			fix(0, at(0), 2),
			fix(60, at(5), 2),
			fix(120, at(3), 2),
			fix(180, at(8), 3),
			fix(225, at(10), 3), // last on-foot fix — the launch point
			fix(240, at(110), 24), // 100 m / 15 s = 24 km/h
			fix(255, at(210), 24),
			fix(270, at(310), 24),
			fix(360, at(900), 26), // drive segment's own fixes
			fix(420, at(1500), 26),
		];
		const out = reassignWalkTailToVehicle([seg(0, 300, "walking"), seg(300, 540, "driving")], pts);
		expect(out).toHaveLength(2);
		expect(out[0].mode).toBe("walking");
		expect(out[1].mode).toBe("driving");
		// boundary moved back to the launch fix (225), not the old 300.
		expect(out[0].endTs).toBe(225);
		expect(out[1].startTs).toBe(225);
		// the walk no longer contains any motorised motion.
		expect(maxStep(pts, out[0].startTs, out[0].endTs)).toBeLessThan(15);
		// and its reported maxSpeed is no longer the 27 it inherited.
		expect(out[0].maxSpeed).toBeLessThan(15);
	});

	it("does NOT shed the tail when the next segment is not a vehicle", () => {
		// Same fast tail, but followed by a stationary stay — there is no
		// vehicle to reassign into, so we must not invent one. (A genuine
		// hidden ride with no vehicle neighbour is the interior-ride pass's
		// job, at its higher distance bar.)
		const pts = [
			fix(0, at(0), 2),
			fix(60, at(5), 2),
			fix(120, at(3), 2),
			fix(180, at(8), 3),
			fix(225, at(10), 3),
			fix(240, at(110), 24),
			fix(255, at(210), 24),
			fix(270, at(310), 24),
		];
		const out = reassignWalkTailToVehicle([seg(0, 300, "walking"), seg(300, 900, "stationary")], pts);
		expect(out).toHaveLength(2);
		expect(out[0].endTs).toBe(300);
		expect(out[0].mode).toBe("walking");
	});

	it("does NOT shed a jittery high-speed tail with no net progress", () => {
		// Urban-canyon platform jitter at the boundary: high speed readings,
		// but the position never leaves a ~20 m cluster. Net displacement
		// gate rejects it even though the next segment is a drive.
		const pts = [
			fix(0, at(0), 3),
			fix(60, at(5), 3),
			fix(120, at(3), 3),
			fix(180, at(8), 3),
			fix(225, at(10), 3),
			fix(240, at(-8), 22),
			fix(255, at(12), 22),
			fix(270, at(-5), 22),
		];
		const out = reassignWalkTailToVehicle([seg(0, 300, "walking"), seg(300, 540, "driving")], pts);
		expect(out).toHaveLength(2);
		expect(out[0].endTs).toBe(300);
	});

	it("does NOT shed on a single glitchy fast step", () => {
		// One fast step at the tail could be a lone GPS spike; require a
		// sustained run (≥2 vehicle-paced steps).
		const pts = [
			fix(0, at(0), 2),
			fix(60, at(5), 2),
			fix(120, at(3), 2),
			fix(180, at(8), 3),
			fix(240, at(15), 3),
			fix(270, at(210), 24), // single 195 m jump
		];
		const out = reassignWalkTailToVehicle([seg(0, 300, "walking"), seg(300, 540, "driving")], pts);
		expect(out).toHaveLength(2);
		expect(out[0].endTs).toBe(300);
	});

	it("leaves a genuine slow walk into a drive untouched", () => {
		const pts = Array.from({ length: 6 }, (_, i) => fix(i * 60, at(i * 5), 4));
		const out = reassignWalkTailToVehicle([seg(0, 300, "walking"), seg(300, 540, "driving")], pts);
		expect(out).toHaveLength(2);
		expect(out[0].endTs).toBe(300);
	});

	it("ignores a walk with no following segment", () => {
		const pts = [fix(0, at(0), 3), fix(120, at(10), 3), fix(240, at(310), 24), fix(270, at(410), 24)];
		const out = reassignWalkTailToVehicle([seg(0, 300, "walking")], pts);
		expect(out).toHaveLength(1);
		expect(out[0].endTs).toBe(300);
	});
});
