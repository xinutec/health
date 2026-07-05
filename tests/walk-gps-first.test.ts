import { describe, expect, it } from "vitest";
import type { RoadGeometry } from "../src/geo/road-match.js";
import { nudgeTowardWays } from "../src/geo/walk-building-escape.js";

/**
 * `nudgeTowardWays` — the "respect the GPS" half of the GPS-first walk draw:
 * each vertex may move a BOUNDED distance onto a nearby walkable way (a slight
 * smart correction), never further. A vertex with no way nearby, or one whose
 * nearest way is beyond the nudge reach, stays exactly where the GPS put it.
 */

const LAT = 51.563;
const LON = -0.281;
const dLat = (m: number) => m / 111_320;
const dLon = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

// One east-west street along LAT.
const street: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "High Street",
			subtype: "residential",
			coords: [
				[LAT, LON - dLon(100)],
				[LAT, LON + dLon(100)],
			],
		},
	],
};

const offM = (p: { lat: number }) => Math.abs(p.lat - LAT) * 111_320;

describe("nudgeTowardWays", () => {
	it("snaps a vertex within reach fully onto the way", () => {
		// 8 m off the street, nudge reach 15 m → lands on the centreline.
		const out = nudgeTowardWays([{ lat: LAT + dLat(8), lon: LON, ts: 1 }], street, 15);
		expect(offM(out[0])).toBeLessThan(0.5);
		expect(out[0].ts).toBe(1);
	});

	it("leaves a vertex beyond reach exactly where the GPS put it", () => {
		// 40 m off the street: the way is out of nudge reach. A partial move would
		// strand the point in no-man's-land (neither the GPS truth nor the
		// pavement) — respect the GPS instead and do not touch it.
		const out = nudgeTowardWays([{ lat: LAT + dLat(40), lon: LON, ts: 2 }], street, 15);
		expect(offM(out[0])).toBeCloseTo(40, 1);
	});

	it("leaves a vertex alone when there is no way at all", () => {
		const out = nudgeTowardWays([{ lat: LAT + dLat(8), lon: LON, ts: 3 }], { ways: [] }, 15);
		expect(offM(out[0])).toBeCloseTo(8, 1);
	});

	it("keeps an on-way vertex untouched", () => {
		const out = nudgeTowardWays([{ lat: LAT, lon: LON, ts: 4 }], street, 15);
		expect(offM(out[0])).toBeLessThan(0.1);
	});
});
