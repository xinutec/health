/**
 * Tests for `bestPlace` reading OSM lookups via an `OsmAdapter`.
 *
 * Phase 6d of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Pre-Phase-6d, `bestPlace` directly imports `nearbyLandmarks` and
 * `reverseGeocode` from `osm.ts` — there is no way to inject either,
 * so these tests can't even compile. The refactor's contract is what
 * these tests pin down:
 *
 *   - `bestPlace(osm, lat, lon, opts)` takes an `OsmAdapter` as its
 *     first parameter and reads OSM/Nominatim only through it.
 *   - The behaviour rules tested here mirror what the prod
 *     implementation already does. If those rules later change, the
 *     test changes with the rule; the *threading* (adapter is
 *     consulted at the right points) stays load-bearing.
 *
 * Real-data behaviour parity is verified by the golden suite, not
 * here. These tests cover the surface — adapter is wired, the rules
 * route to the right adapter primitives.
 */

import { describe, expect, it } from "vitest";
import { bestPlace, type NearbyLandmark, type NominatimResult } from "../src/geo/osm.js";
import { mockOsmAdapter } from "./helpers/mock-osm-adapter.js";

function landmark(
	name: string,
	type: NearbyLandmark["type"],
	subtype: string,
	distanceM: number,
	opts: { enclosing?: boolean } = {},
): NearbyLandmark {
	return { name, type, subtype, distanceM, ...opts };
}

function venueResult(amenity: string, type: string): NominatimResult {
	return {
		displayName: `${amenity}, Ashvale, London`,
		type,
		category: "amenity",
		address: { amenity, road: "Acacia Avenue", city: "Greater London" },
	};
}

function residentialResult(road: string, houseNumber: string): NominatimResult {
	return {
		displayName: `${houseNumber} ${road}, London`,
		type: "house",
		category: "building",
		address: { road, house_number: houseNumber, city: "Greater London" },
	};
}

describe("bestPlace via OsmAdapter", () => {
	it("calls nearbyLandmarks(100m) and reverseGeocode(zoom=18) once each at the query coord", async () => {
		const osm = mockOsmAdapter();
		await bestPlace(osm, 51.5, -0.1);

		expect(osm.calls.nearbyLandmarks).toHaveLength(1);
		expect(osm.calls.nearbyLandmarks[0].args).toEqual([51.5, -0.1, 100]);

		// Zoom-18 (building level) always fires; the zoom-16 fallback
		// only fires when nothing else won.
		expect(osm.calls.reverseGeocode[0].args).toEqual([51.5, -0.1, 18]);
	});

	it("returns a specific-venue Nominatim result over a nearby landmark", async () => {
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [landmark("Local Cafe", "amenity", "cafe", 25)],
			reverseGeocode: (_lat, _lon, zoom) => (zoom === 18 ? venueResult("Brasserie Z", "restaurant") : null),
		});
		const result = await bestPlace(osm, 51.5, -0.1);
		expect(result?.displayName).toContain("Brasserie Z");
		expect(result?.address.amenity).toBe("Brasserie Z");
	});

	it("uses an enclosing-institution landmark even when Nominatim returns a specific venue", async () => {
		// A stay whose centroid sits inside a hospital's mapped footprint
		// is a stay *in* the hospital, regardless of a closer cafe POI.
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [
				landmark("Cleveland Clinic London", "amenity", "hospital", 5, { enclosing: true }),
				landmark("Lobby Cafe", "amenity", "cafe", 1),
			],
			reverseGeocode: (_lat, _lon, zoom) => (zoom === 18 ? venueResult("Lobby Cafe", "cafe") : null),
		});
		const result = await bestPlace(osm, 51.52, -0.15);
		expect(result?.displayName).toBe("Cleveland Clinic London");
	});

	it("with preferResidential, picks a lodging POI within 50m over the residential address", async () => {
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [landmark("Guest House Vertoef", "tourism", "guest_house", 12)],
			reverseGeocode: (_lat, _lon, zoom) => (zoom === 18 ? residentialResult("Some Street", "42") : null),
		});
		const result = await bestPlace(osm, 51.5, -0.1, { preferResidential: true });
		expect(result?.displayName).toBe("Guest House Vertoef");
	});

	it("with preferResidential, falls back to the residential address when no lodging POI is near", async () => {
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [],
			reverseGeocode: (_lat, _lon, zoom) => (zoom === 18 ? residentialResult("Acacia Avenue", "42") : null),
		});
		const result = await bestPlace(osm, 51.5, -0.1, { preferResidential: true });
		expect(result?.address.house_number).toBe("42");
		expect(result?.address.road).toBe("Acacia Avenue");
	});

	it("falls back to zoom-16 area lookup when nothing wins at zoom-18", async () => {
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [],
			reverseGeocode: (_lat, _lon, zoom) =>
				zoom === 16
					? { displayName: "Hyde Park, London", type: "park", category: "leisure", address: { leisure: "Hyde Park" } }
					: null,
		});
		const result = await bestPlace(osm, 51.5, -0.16);
		expect(result?.displayName).toBe("Hyde Park, London");
		// Both zooms consulted.
		const zooms = osm.calls.reverseGeocode.map((c) => c.args[2]).sort();
		expect(zooms).toEqual([16, 18]);
	});

	it("returns null when neither landmarks nor Nominatim have anything", async () => {
		const osm = mockOsmAdapter();
		const result = await bestPlace(osm, 51.5, -0.1);
		expect(result).toBeNull();
	});
});

/** Visit mass spread uniformly over [from, to) local hours. */
function hourMass(visits: number, from: number, to: number): number[] {
	const hours = new Array(24).fill(0);
	for (let h = from; h < to; h++) hours[h] = visits / (to - from);
	return hours;
}

describe("bestPlace with stay context (venue-plausibility path, #246)", () => {
	// Tuesday 2026-06-09, Europe/London (BST): a 19:03–20:17 dinner sit.
	const DINNER = {
		startUnix: Date.UTC(2026, 5, 9, 18, 3) / 1000,
		endUnix: Date.UTC(2026, 5, 9, 19, 17) / 1000,
		tz: "Europe/London",
	};

	it("folds a Nominatim point-venue into the ranking instead of letting it bypass", async () => {
		// Without stay context the Nominatim venue short-circuits. With it,
		// an open landmark restaurant must be able to beat a closed
		// Nominatim venue on evidence.
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [
				{
					name: "Open Trattoria",
					type: "amenity" as const,
					subtype: "restaurant",
					distanceM: 20,
					openingHours: "Mo-Su 12:00-23:00",
				},
			],
			reverseGeocode: (_lat, _lon, zoom) => (zoom === 18 ? venueResult("Closed Bistro", "restaurant") : null),
		});
		const withStay = await bestPlace(osm, 51.5, -0.1, { stay: DINNER });
		expect(withStay?.displayName).toBe("Open Trattoria");
	});

	it("still returns the Nominatim venue when it wins the ranking", async () => {
		// The centroid is ON the venue's building (distance 0) and nothing
		// nearby out-scores it — the Nominatim result (with its address
		// fields) is returned, not a synthesized landmark result.
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [{ name: "Far Cafe", type: "amenity" as const, subtype: "cafe", distanceM: 80 }],
			reverseGeocode: (_lat, _lon, zoom) => (zoom === 18 ? venueResult("Brasserie Z", "restaurant") : null),
		});
		const result = await bestPlace(osm, 51.5, -0.1, { stay: DINNER });
		expect(result?.address.amenity).toBe("Brasserie Z");
		expect(result?.address.road).toBe("Acacia Avenue");
	});

	it("threads mined priors: dinner-shaped sit resolves to the restaurant, not the closer errand venue", async () => {
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [
				{ name: "Corner Pharmacy", type: "amenity" as const, subtype: "pharmacy", distanceM: 18 },
				{ name: "Trattoria", type: "amenity" as const, subtype: "restaurant", distanceM: 32 },
			],
		});
		const priors = {
			bySubtype: {
				restaurant: { visits: 40, dwell: [0, 0, 40, 0], hours: hourMass(40, 12, 22) },
				pharmacy: { visits: 3, dwell: [3, 0, 0, 0], hours: hourMass(3, 10, 17) },
			},
			byCategory: {
				food: { visits: 40, dwell: [0, 0, 40, 0], hours: hourMass(40, 12, 22) },
				errand: { visits: 3, dwell: [3, 0, 0, 0], hours: hourMass(3, 10, 17) },
			},
			totalVisits: 43,
		};
		const result = await bestPlace(osm, 51.5, -0.1, { stay: DINNER, priors });
		expect(result?.displayName).toBe("Trattoria");
	});

	it("falls through to the area lookup when every venue is implausible (honest floor)", async () => {
		// A single distant closed venue must not name the stay — the
		// zoom-16 area label is the honest answer.
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [
				{
					name: "Closed Bistro",
					type: "amenity" as const,
					subtype: "restaurant",
					distanceM: 85,
					openingHours: "Mo-Fr 09:00-17:00",
				},
			],
			reverseGeocode: (_lat, _lon, zoom) =>
				zoom === 16
					? {
							displayName: "Station Square, London",
							type: "square",
							category: "place",
							address: { pedestrian: "Station Square" },
						}
					: null,
		});
		const result = await bestPlace(osm, 51.5, -0.1, { stay: DINNER });
		expect(result?.displayName).toBe("Station Square, London");
	});

	it("keeps the enclosing-institution override absolute under stay context", async () => {
		const osm = mockOsmAdapter({
			nearbyLandmarks: () => [
				{ name: "Lobby Cafe", type: "amenity" as const, subtype: "cafe", distanceM: 1, openingHours: "24/7" },
				{ name: "City Hospital", type: "amenity" as const, subtype: "hospital", distanceM: 55, enclosing: true },
			],
		});
		const result = await bestPlace(osm, 51.5, -0.1, { stay: DINNER });
		expect(result?.displayName).toBe("City Hospital");
	});
});
