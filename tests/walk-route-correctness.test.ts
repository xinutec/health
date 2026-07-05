import { describe, expect, it } from "vitest";
import { onNamedWayFraction } from "../src/eval/walk-route-correctness.js";
import type { RoadGeometry } from "../src/geo/road-match.js";

/**
 * `onNamedWayFraction` — the truth-anchored route-correctness metric. Given the
 * street name(s) the ground-truth narrative confirms for a walk window, it
 * reports what fraction of the DRAWN line's length actually runs along that
 * street. An invented detour onto a different street drops the fraction; a
 * faithful walk (even a there-and-back on the SAME street) keeps it high — which
 * is the whole point: it separates a real feature from an artifact by NAME, not
 * by geometry, so it doesn't punish a genuine out-and-back the off-walkable and
 * corridor-stall proxies confound.
 */

// A tiny grid: "Larch Rise" runs west→east along a constant latitude; a
// perpendicular "Forty Avenue" crosses it; a parallel "Wrong Street" sits ~40 m
// north (far enough that a point on it is nearer Wrong Street than Larch Rise).
const LAT = 51.56;
const dLatFor = (m: number) => m / 111_320;

const NORTH_40 = LAT + dLatFor(40);

const geo: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "Larch Rise",
			subtype: "residential",
			coords: [
				[LAT, -0.28],
				[LAT, -0.278],
				[LAT, -0.276],
			],
		},
		{
			osmId: 2,
			name: "Wrong Street",
			subtype: "residential",
			coords: [
				[NORTH_40, -0.28],
				[NORTH_40, -0.276],
			],
		},
	],
};

/** A polyline straight along Larch Rise between two longitudes at LAT. */
function alongLarchRise(lonA: number, lonB: number, n = 20): Array<{ lat: number; lon: number }> {
	const out: Array<{ lat: number; lon: number }> = [];
	for (let i = 0; i <= n; i++) out.push({ lat: LAT, lon: lonA + ((lonB - lonA) * i) / n });
	return out;
}

describe("onNamedWayFraction", () => {
	it("a line lying on the named street scores ~1", () => {
		const drawn = alongLarchRise(-0.28, -0.276);
		const f = onNamedWayFraction(drawn, new Set(["larch rise"]), geo);
		expect(f).not.toBeNull();
		expect(f as number).toBeGreaterThan(0.95);
	});

	it("half the line detouring onto a different street scores ~0.5", () => {
		// First half along Larch Rise, second half jumps north onto Wrong Street.
		const first = alongLarchRise(-0.28, -0.278, 10);
		const second: Array<{ lat: number; lon: number }> = [];
		for (let i = 0; i <= 10; i++) second.push({ lat: NORTH_40, lon: -0.278 + (0.002 * i) / 10 });
		const f = onNamedWayFraction([...first, ...second], new Set(["larch rise"]), geo);
		expect(f).not.toBeNull();
		expect(f as number).toBeGreaterThan(0.35);
		expect(f as number).toBeLessThan(0.65);
	});

	it("normalises case and whitespace when matching names", () => {
		const drawn = alongLarchRise(-0.28, -0.276);
		expect(onNamedWayFraction(drawn, new Set(["  Larch   Rise "]), geo) as number).toBeGreaterThan(0.95);
	});

	it("returns null when there is no accepted name to score against", () => {
		expect(onNamedWayFraction(alongLarchRise(-0.28, -0.276), new Set(), geo)).toBeNull();
	});

	it("returns null when there is no walkable geometry", () => {
		expect(onNamedWayFraction(alongLarchRise(-0.28, -0.276), new Set(["larch rise"]), { ways: [] })).toBeNull();
	});

	it("counts a point beyond the match radius as off the named street", () => {
		// A line 30 m north of Larch Rise (> default 25 m radius) is nowhere near
		// an accepted way → fraction ~0.
		const off = alongLarchRise(-0.28, -0.276).map((p) => ({ lat: p.lat + dLatFor(30), lon: p.lon }));
		expect(onNamedWayFraction(off, new Set(["larch rise"]), geo) as number).toBeLessThan(0.1);
	});
});
