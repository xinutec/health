import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment } from "../src/geo/segments.js";
import { reassignVehicleArrivalWalk } from "../src/geo/stay-split.js";

// Synthetic scenarios. Movement is in latitude only; ~111,195 m per degree,
// so `at(m)` places a fix m metres north of a fixed origin.
const ORIGIN = 51.0;
const at = (m: number): number => ORIGIN + m / 111195;

function fix(ts: number, lat: number, speed_kmh: number): FilteredPoint {
	return { ts, lat, lon: 0, speed_kmh, bearing: 0 };
}
function seg(startTs: number, endTs: number, mode: string): TrackSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 0.5,
		avgSpeed: mode === "walking" ? 3 : mode === "driving" ? 20 : 0,
		maxSpeed: mode === "walking" ? 30 : mode === "driving" ? 40 : 3,
		linearity: 0.5,
		pointCount: 0,
	} as TrackSegment;
}

describe("reassignVehicleArrivalWalk", () => {
	// The 2026-07-09 bug: a drive decelerating to a halt at Home had its final
	// fast fixes glued to the first minutes of the Home stay; the parked zeros
	// diluted the mean to walking pace, so a phantom "walk on The Avenue"
	// appeared between the drive and the stay. Both neighbours corroborate:
	// drive before, stay after. The vehicle-paced head belongs to the drive,
	// and the parked residual is the arrival — so the walk dissolves entirely.
	it("dissolves a walk that is a drive's arrival tail into the drive + stay", () => {
		const pts = [
			// drive (0–200)
			fix(0, at(0), 25),
			fix(60, at(200), 25),
			fix(120, at(400), 25),
			fix(180, at(600), 25),
			// walk window (200–500): vehicle-paced head to the stay, then parked
			fix(210, at(700), 20),
			fix(240, at(850), 20),
			fix(270, at(1000), 20), // arrives at the stay
			fix(330, at(1000), 0),
			fix(400, at(1000), 0),
			fix(470, at(1000), 0),
			// stay (500–800) at at(1000)
			fix(540, at(1000), 0),
			fix(600, at(1000), 0),
			fix(700, at(1000), 0),
		];
		const out = reassignVehicleArrivalWalk(
			[seg(0, 200, "driving"), seg(200, 500, "walking"), seg(500, 800, "stationary")],
			pts,
		);
		// walk gone: just the (extended) drive and the (extended) stay.
		expect(out.map((s) => s.mode)).toEqual(["driving", "stationary"]);
		expect(out[0].endTs).toBe(270); // drive extended forward to the halt
		expect(out[1].startTs).toBe(270); // stay extended back to the halt
	});

	// Dropped off short of the door, then a real walk in (2026-06-02 taxi home):
	// even though the walk has a vehicle-paced head, the residual walks on foot
	// to the stay — that is a genuine walk-in, so the pass must leave the whole
	// segment untouched rather than eat it. Precision over recall.
	it("leaves the whole walk untouched when the residual walks to the door", () => {
		const pts = [
			fix(0, at(0), 25),
			fix(120, at(400), 25),
			fix(180, at(600), 25),
			// walk window (200–600): vehicle head, then a real walk that keeps going
			fix(210, at(700), 20),
			fix(240, at(850), 20),
			fix(270, at(1000), 20),
			fix(360, at(1080), 4), // walking on, net progress past the head
			fix(450, at(1160), 4),
			fix(540, at(1240), 4),
			fix(640, at(1300), 0),
			fix(720, at(1300), 0),
		];
		const out = reassignVehicleArrivalWalk(
			[seg(0, 200, "driving"), seg(200, 600, "walking"), seg(600, 800, "stationary")],
			pts,
		);
		expect(out.map((s) => s.mode)).toEqual(["driving", "walking", "stationary"]);
		expect(out[0].endTs).toBe(200); // drive not extended
		expect(out[1].startTs).toBe(200); // walk not shortened
	});

	it("leaves the walk alone when no road vehicle precedes it", () => {
		const pts = [
			fix(0, at(0), 3),
			fix(120, at(10), 3),
			fix(210, at(700), 20),
			fix(240, at(850), 20),
			fix(270, at(1000), 20),
			fix(400, at(1000), 0),
			fix(540, at(1000), 0),
		];
		// walking → walking → stationary: no vehicle predecessor.
		const out = reassignVehicleArrivalWalk(
			[seg(0, 200, "walking"), seg(200, 500, "walking"), seg(500, 800, "stationary")],
			pts,
		);
		expect(out.map((s) => s.mode)).toEqual(["walking", "walking", "stationary"]);
		expect(out[1].startTs).toBe(200);
	});

	it("leaves the walk alone when no stationary stay follows it", () => {
		const pts = [
			fix(0, at(0), 25),
			fix(120, at(400), 25),
			fix(210, at(700), 20),
			fix(240, at(850), 20),
			fix(270, at(1000), 20),
			fix(400, at(1200), 20),
			fix(540, at(1400), 20),
		];
		// drive → walk → drive: the arrival case needs a stay to fold into.
		const out = reassignVehicleArrivalWalk(
			[seg(0, 200, "driving"), seg(200, 500, "walking"), seg(500, 800, "driving")],
			pts,
		);
		expect(out.map((s) => s.mode)).toEqual(["driving", "walking", "driving"]);
		expect(out[1].startTs).toBe(200);
	});

	it("does not fire on a genuine slow walk from a drop-off to the stay", () => {
		// No vehicle-paced head at all — a real short walk from the kerb.
		const pts = [
			fix(0, at(0), 25),
			fix(120, at(400), 25),
			fix(210, at(700), 4),
			fix(300, at(760), 4),
			fix(390, at(820), 4),
			fix(480, at(880), 4),
			fix(560, at(900), 0),
			fix(650, at(900), 0),
		];
		const out = reassignVehicleArrivalWalk(
			[seg(0, 200, "driving"), seg(200, 500, "walking"), seg(500, 800, "stationary")],
			pts,
		);
		expect(out.map((s) => s.mode)).toEqual(["driving", "walking", "stationary"]);
		expect(out[1].startTs).toBe(200);
	});
});
