import { describe, expect, it } from "vitest";
import {
	BUS_STOP_ANCHOR_M,
	type BusRoute,
	type BusStop,
	matchBusRoute,
	type VehicleLegEndpoints,
} from "../src/geo/bus-route-match.js";

/**
 * Stop-anchored bus-route matcher (`src/geo/bus-route-match.ts`). Pins the
 * properties that make it rail-snap-disciplined: a leg matches a route only
 * by anchoring its board + alight to two stops IN ROUTE ORDER, direction is
 * enforced (a reverse ride is a different relation), endpoints that don't
 * reach a stop leave the leg unmatched (taxi), among competing routes the
 * closest-fitting one wins — AND the leg's trace must corroborate the ride
 * by passing the route's intermediate stops, so a taxi that merely clips two
 * of a route's stops is not named that route. Synthetic coords, no DB/OSM.
 */

// London-ish latitude; ~0.004° lon ≈ 280 m, so stops are spaced ~280 m.
const LAT = 51.52;
const LON0 = -0.14;
const STOP_DLON = 0.004;

/** A straight west→east route of `n` stops spaced STOP_DLON apart. */
function linearRoute(routeRef: string, n: number, relId: number, latOffset = 0): BusRoute {
	const stops: BusStop[] = [];
	for (let i = 0; i < n; i++) {
		stops.push({ name: `${routeRef}-stop-${i}`, lat: LAT + latOffset, lon: LON0 + i * STOP_DLON, seq: i });
	}
	return { routeRef, routeName: `Route ${routeRef}`, osmRelationId: relId, stops };
}

/** A coord `meters` east of stop `i` of the given route's geometry. */
function nearStop(route: BusRoute, i: number, metersEast = 0): { lat: number; lon: number } {
	const s = route.stops[i];
	// 1° lon ≈ 69_000 m at this latitude.
	return { lat: s.lat, lon: s.lon + metersEast / 69_000 };
}

/** A leg that genuinely rides `route` from stop `boardIdx` to `alightIdx`:
 *  endpoints at those stops, and a trace with one point at every stop on the
 *  span — so every intermediate stop lies on the trace (full corroboration).
 *  This is the "real bus" shape; tests that want a taxi build their own
 *  trace that diverges. */
function ride(route: BusRoute, boardIdx: number, alightIdx: number): VehicleLegEndpoints {
	const trace: { lat: number; lon: number }[] = [];
	for (let i = boardIdx; i <= alightIdx; i++) trace.push({ lat: route.stops[i].lat, lon: route.stops[i].lon });
	return { board: trace[0], alight: trace[trace.length - 1], trace };
}

describe("matchBusRoute", () => {
	it("returns null when there are no candidate routes", () => {
		const r = linearRoute("38", 6, 1);
		expect(matchBusRoute(ride(r, 1, 4), [])).toBeNull();
	});

	it("discounts the bus hypothesis by speed — a fast leg on the same geometry isn't a bus", () => {
		// Identical fully-corroborated forward ride geometry; only the leg's
		// speed differs. Bus-pace and unspecified speed match; a 62 km/h leg
		// (the Deepwell→St Pancras Tube-hop chord that paralleled route 390)
		// has too low a bus-speed plausibility to clear the score, so it's left
		// unmatched — weighted evidence, not a hard veto.
		const r = linearRoute("38", 6, 1);
		expect(matchBusRoute({ ...ride(r, 1, 4), speedKmh: 18 }, [r])?.routeRef).toBe("38");
		expect(matchBusRoute({ ...ride(r, 1, 4), speedKmh: undefined }, [r])?.routeRef).toBe("38");
		expect(matchBusRoute({ ...ride(r, 1, 4), speedKmh: 62 }, [r])).toBeNull();
	});

	it("matches a forward ride whose trace passes the intermediate stops", () => {
		const r = linearRoute("38", 6, 1);
		const m = matchBusRoute(ride(r, 1, 4), [r]);
		expect(m).not.toBeNull();
		expect(m?.routeRef).toBe("38");
		expect(m?.boardStop.seq).toBe(1);
		expect(m?.alightStop.seq).toBe(4);
		expect(m?.stopSpan).toBe(4); // stops 1,2,3,4 inclusive
		expect(m?.boardDistM).toBeLessThan(BUS_STOP_ANCHOR_M);
		expect(m?.alightDistM).toBeLessThan(BUS_STOP_ANCHOR_M);
	});

	it("does NOT match a ride in the wrong route direction (alight before board)", () => {
		// OSM models each direction separately; this single relation runs
		// west→east. A leg boarding at stop 4 and alighting at stop 1 rode the
		// OTHER direction — not this relation.
		const r = linearRoute("38", 6, 1);
		const trace = [4, 3, 2, 1].map((i) => ({ lat: r.stops[i].lat, lon: r.stops[i].lon }));
		const m = matchBusRoute({ board: trace[0], alight: trace[trace.length - 1], trace }, [r]);
		expect(m).toBeNull();
	});

	it("leaves the leg unmatched when an endpoint reaches no stop (taxi pattern)", () => {
		const r = linearRoute("38", 6, 1);
		// Alight 500 m north of the line — no stop within anchor radius.
		const board = nearStop(r, 1);
		const farAlight = { lat: LAT + 500 / 111_000, lon: LON0 + 4 * STOP_DLON };
		const m = matchBusRoute({ board, alight: farAlight, trace: [board, farAlight] }, [r]);
		expect(m).toBeNull();
	});

	it("does not match when board and alight anchor to the same stop (no travel)", () => {
		const r = linearRoute("38", 6, 1);
		const board = nearStop(r, 2, 10);
		const alight = nearStop(r, 2, -10);
		const m = matchBusRoute({ board, alight, trace: [board, alight] }, [r]);
		expect(m).toBeNull();
	});

	it("picks the closer-fitting route when two routes both cover the endpoints", () => {
		// Route 38 runs exactly through the endpoints; route 274 is shifted
		// ~50 m north, so its stops are farther from the (on-38) endpoints.
		const r38 = linearRoute("38", 6, 1);
		const r274 = linearRoute("274", 6, 2, 50 / 111_000);
		const m = matchBusRoute(ride(r38, 1, 4), [r274, r38]);
		expect(m?.routeRef).toBe("38");
	});

	it("on a route that loops past the board coord twice, picks the in-order pair", () => {
		// Stops: 0,1,2,3 head east, then 4 loops back near stop 1's location.
		// Board near eastbound stop 1; alight near stop 3 (intermediate stop 2
		// corroborates). Must choose boardIdx=1 (not loop stop 4) so
		// boardIdx < alightIdx holds and the total anchor distance is minimal.
		const stops: BusStop[] = [
			{ name: "a", lat: LAT, lon: LON0 + 0 * STOP_DLON, seq: 0 },
			{ name: "b", lat: LAT, lon: LON0 + 1 * STOP_DLON, seq: 1 },
			{ name: "c", lat: LAT, lon: LON0 + 2 * STOP_DLON, seq: 2 },
			{ name: "d", lat: LAT, lon: LON0 + 3 * STOP_DLON, seq: 3 },
			{ name: "e", lat: LAT, lon: LON0 + 1 * STOP_DLON, seq: 4 }, // loops back near stop 1
		];
		const route: BusRoute = { routeRef: "C2", routeName: "Loop", osmRelationId: 9, stops };
		const trace = [1, 2, 3].map((i) => ({ lat: stops[i].lat, lon: stops[i].lon }));
		const m = matchBusRoute({ board: trace[0], alight: trace[trace.length - 1], trace }, [route]);
		expect(m).not.toBeNull();
		expect(m?.boardStop.seq).toBe(1);
		expect(m?.alightStop.seq).toBe(3);
	});

	it("carries the board/alight stop names through for the timeline label", () => {
		const r = linearRoute("38", 6, 1);
		const m = matchBusRoute(ride(r, 0, 5), [r]);
		expect(m?.boardStop.name).toBe("38-stop-0");
		expect(m?.alightStop.name).toBe("38-stop-5");
	});

	it("rejects a taxi that anchors two stops but diverges from the route between them", () => {
		// The 2026-06-15 phantom-N22 class: endpoints anchor stops 1 and 4, but
		// the trace bows ~400 m north between them, never passing intermediates
		// 2 and 3. A real bus would pass them — so this stays driving.
		const r = linearRoute("38", 6, 1);
		const board = nearStop(r, 1);
		const alight = nearStop(r, 4);
		const detour = { lat: LAT + 400 / 111_000, lon: LON0 + 2.5 * STOP_DLON };
		expect(matchBusRoute({ board, alight, trace: [board, detour, alight] }, [r])).toBeNull();
		// Contrast: same endpoints, but a trace that follows the route's stops
		// IS that bus.
		expect(matchBusRoute(ride(r, 1, 4), [r])?.routeRef).toBe("38");
	});

	it("rejects a two-stop span — no intermediate stop can corroborate it (the N22 taxi shape)", () => {
		// Berkeley Street → Farvale Station were two adjacent N22 stops; a
		// taxi clipping both got named the route. With nothing between board and
		// alight to corroborate, the only honest answer is driving.
		const r = linearRoute("38", 6, 1);
		expect(matchBusRoute(ride(r, 1, 2), [r])).toBeNull();
	});
});
