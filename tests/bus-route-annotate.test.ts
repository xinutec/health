import { describe, expect, it } from "vitest";
import { annotateBusRoutes, type BusRoute, type BusRouteMatch, busRouteLabel } from "../src/geo/bus-route-match.js";
import type { TransportMode } from "../src/geo/segments.js";

/**
 * `annotateBusRoutes` is the pipeline pass that names a driving leg's bus
 * route. Pins: only driving legs are touched, a stop-sequence match marks
 * the leg `bus` + sets the `From → To · Ref` label, an empty route set is
 * a no-op (the golden-safety property), and a non-matching leg stays a
 * taxi. Synthetic coords + segments, no DB.
 */

const LAT = 51.52;
const LON0 = -0.14;
const STOP_DLON = 0.004;

function linearRoute(): BusRoute {
	const stops = Array.from({ length: 6 }, (_, i) => ({
		name: `stop-${i}`,
		lat: LAT,
		lon: LON0 + i * STOP_DLON,
		seq: i,
	}));
	return { routeRef: "38", routeName: "Route 38", osmRelationId: 1, stops };
}

/** Fixes marching along the route from stop `i0` to stop `i1`, one per minute. */
function fixesAlong(i0: number, i1: number, startTs: number): Array<{ ts: number; lat: number; lon: number }> {
	const fixes = [];
	for (let i = i0; i <= i1; i++) fixes.push({ ts: startTs + (i - i0) * 60, lat: LAT, lon: LON0 + i * STOP_DLON });
	return fixes;
}

interface Seg {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	vehicleKind?: "bus";
	wayName?: string;
}

describe("busRouteLabel", () => {
	it("formats a named match as 'From → To · Ref'", () => {
		const match = {
			routeRef: "38",
			boardStop: { name: "Farvale", lat: 0, lon: 0, seq: 0 },
			alightStop: { name: "Victoria", lat: 0, lon: 0, seq: 3 },
		} as BusRouteMatch;
		expect(busRouteLabel(match)).toBe("Farvale → Victoria · 38");
	});

	it("falls back to the bare ref when a stop is unnamed", () => {
		const match = {
			routeRef: "38",
			boardStop: { name: null, lat: 0, lon: 0, seq: 0 },
			alightStop: { name: "Victoria", lat: 0, lon: 0, seq: 3 },
		} as BusRouteMatch;
		expect(busRouteLabel(match)).toBe("38");
	});
});

describe("annotateBusRoutes", () => {
	const T0 = 1_700_000_000;

	it("is a no-op when no routes are loaded (golden-safety)", () => {
		const segs: Seg[] = [{ startTs: T0, endTs: T0 + 300, mode: "driving" }];
		const fixes = fixesAlong(1, 4, T0);
		expect(annotateBusRoutes(segs, fixes, [])).toEqual(segs);
	});

	it("names a driving leg that matches a route's stop sequence", () => {
		const segs: Seg[] = [{ startTs: T0, endTs: T0 + 300, mode: "driving" }];
		const fixes = fixesAlong(1, 4, T0); // boards stop 1, alights stop 4
		const out = annotateBusRoutes(segs, fixes, [linearRoute()]);
		expect(out[0].vehicleKind).toBe("bus");
		expect(out[0].wayName).toBe("stop-1 → stop-4 · 38");
	});

	it("leaves a walking leg untouched even when it passes the stops", () => {
		const segs: Seg[] = [{ startTs: T0, endTs: T0 + 300, mode: "walking" }];
		const fixes = fixesAlong(1, 4, T0);
		const out = annotateBusRoutes(segs, fixes, [linearRoute()]);
		expect(out[0].vehicleKind).toBeUndefined();
		expect(out[0].wayName).toBeUndefined();
	});

	it("leaves a driving leg that matches no route as a taxi (no annotation)", () => {
		// Fixes 500 m north of the line — no stop anchors.
		const segs: Seg[] = [{ startTs: T0, endTs: T0 + 300, mode: "driving" }];
		const fixes = [
			{ ts: T0, lat: LAT + 500 / 111_000, lon: LON0 + STOP_DLON },
			{ ts: T0 + 300, lat: LAT + 500 / 111_000, lon: LON0 + 4 * STOP_DLON },
		];
		const out = annotateBusRoutes(segs, fixes, [linearRoute()]);
		expect(out[0].vehicleKind).toBeUndefined();
	});

	it("respects refinedMode (a leg refined to driving is eligible)", () => {
		const segs: Seg[] = [{ startTs: T0, endTs: T0 + 300, mode: "walking", refinedMode: "driving" }];
		const out = annotateBusRoutes(segs, fixesAlong(1, 4, T0), [linearRoute()]);
		expect(out[0].vehicleKind).toBe("bus");
	});

	it("does not mutate the input segments", () => {
		const segs: Seg[] = [{ startTs: T0, endTs: T0 + 300, mode: "driving" }];
		annotateBusRoutes(segs, fixesAlong(1, 4, T0), [linearRoute()]);
		expect(segs[0].vehicleKind).toBeUndefined();
	});
});
