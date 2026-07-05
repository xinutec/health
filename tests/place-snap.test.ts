import { describe, expect, it } from "vitest";
import { type KnownPlace, snapToPlace } from "../src/geo/place-snap.js";

// Helper: shift a point by (north, east) metres for synthetic geometry.
// Approximations are fine for the small distances we test with.
function offset(lat: number, lon: number, north: number, east: number): { lat: number; lon: number } {
	const dLat = north / 111320;
	const dLon = east / (111320 * Math.cos((lat * Math.PI) / 180));
	return { lat: lat + dLat, lon: lon + dLon };
}

const HOME: KnownPlace = { centroidLat: 50.06997, centroidLon: 4.84604, id: "home", radiusM: 12 };
const WORK: KnownPlace = { centroidLat: 50.03317, centroidLon: 4.99934, id: "work", radiusM: 15 };
// Two cafes ~50m apart on the same square — the cafe-next-door setup
const CAFE_A: KnownPlace = { centroidLat: 51.84765, centroidLon: 5.86321, id: "cafeA", radiusM: 10 };
const CAFE_B: KnownPlace = { centroidLat: 51.84796, centroidLon: 5.86384, id: "cafeB", radiusM: 10 };

describe("snapToPlace", () => {
	it("does not snap when there are no places", () => {
		const r = snapToPlace({ lat: 50.06997, lon: 4.84604, accuracy: 100 }, []);
		expect(r.snapped).toBe(false);
		expect(r.lat).toBe(50.06997);
	});

	it("does not snap when no place is within snapRadiusM", () => {
		// A fix near one cluster shouldn't snap to a far-away cluster
		const r = snapToPlace({ lat: HOME.centroidLat, lon: HOME.centroidLon, accuracy: 80 }, [WORK]);
		expect(r.snapped).toBe(false);
	});

	it("snaps a noisy fix to the only nearby place", () => {
		// 40m north of home, accuracy 80m → snap to HOME
		const off = offset(HOME.centroidLat, HOME.centroidLon, 40, 0);
		const r = snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 80 }, [HOME, WORK]);
		expect(r.snapped).toBe(true);
		expect(r.snappedTo?.id).toBe("home");
		expect(r.lat).toBe(HOME.centroidLat);
		expect(r.lon).toBe(HOME.centroidLon);
		expect(r.accuracy).toBe(12);
		expect(r.snapDistanceM).toBeGreaterThan(0);
		expect(r.snapDistanceM).toBeLessThan(50);
	});

	it("does NOT snap a high-accuracy fix (we trust the fix more than the cluster)", () => {
		// 5m east of home, accuracy 8m — fix is more precise than our knowledge of home
		const off = offset(HOME.centroidLat, HOME.centroidLon, 0, 5);
		const r = snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 8 }, [HOME]);
		expect(r.snapped).toBe(false);
		expect(r.lat).toBe(off.lat);
	});

	it("snaps when accuracy is null (treat as unknown / poor)", () => {
		const off = offset(HOME.centroidLat, HOME.centroidLon, 30, 0);
		const r = snapToPlace({ lat: off.lat, lon: off.lon, accuracy: null }, [HOME]);
		expect(r.snapped).toBe(true);
	});

	it("does NOT snap when two cafes are equally plausible (ambiguous)", () => {
		// Midpoint between CAFE_A and CAFE_B with poor accuracy → ambiguous
		const midLat = (CAFE_A.centroidLat + CAFE_B.centroidLat) / 2;
		const midLon = (CAFE_A.centroidLon + CAFE_B.centroidLon) / 2;
		const r = snapToPlace({ lat: midLat, lon: midLon, accuracy: 60 }, [CAFE_A, CAFE_B]);
		expect(r.snapped).toBe(false);
	});

	it("snaps to the closer of two cafes when one is unambiguously closer", () => {
		// Sit 5m from CAFE_A (so 50m+ from CAFE_B) with poor accuracy → snap to A
		const off = offset(CAFE_A.centroidLat, CAFE_A.centroidLon, 5, 0);
		const r = snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 60 }, [CAFE_A, CAFE_B]);
		expect(r.snapped).toBe(true);
		expect(r.snappedTo?.id).toBe("cafeA");
	});

	it("respects a custom snapRadiusM", () => {
		// 90m north of home — outside default 75m, inside custom 100m
		const off = offset(HOME.centroidLat, HOME.centroidLon, 90, 0);
		expect(snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 100 }, [HOME]).snapped).toBe(false);
		expect(snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 100 }, [HOME], { snapRadiusM: 100 }).snapped).toBe(true);
	});

	it("respects a custom minAccuracyToSnapM (e.g. always snap when in range)", () => {
		// 5m offset, accuracy 8m — would not snap at default; with min=0 it should
		const off = offset(HOME.centroidLat, HOME.centroidLon, 0, 5);
		expect(snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 8 }, [HOME]).snapped).toBe(false);
		expect(snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 8 }, [HOME], { minAccuracyToSnapM: 0 }).snapped).toBe(
			true,
		);
	});

	it("falls back to 10m default accuracy when the place has no radiusM", () => {
		const placeNoRadius: KnownPlace = { centroidLat: HOME.centroidLat, centroidLon: HOME.centroidLon };
		const off = offset(HOME.centroidLat, HOME.centroidLon, 30, 0);
		const r = snapToPlace({ lat: off.lat, lon: off.lon, accuracy: 100 }, [placeNoRadius]);
		expect(r.snapped).toBe(true);
		expect(r.accuracy).toBe(10);
	});

	it("ambiguityRatio=1 effectively disables ambiguity guard (always picks closest)", () => {
		// Midpoint with a tiny tilt toward CAFE_A (lower lat) — at default ratio 2.0 this
		// would still be flagged ambiguous; at ratio 1.0 the closest wins.
		const midLat = (CAFE_A.centroidLat + CAFE_B.centroidLat) / 2 - 0.00001;
		const midLon = (CAFE_A.centroidLon + CAFE_B.centroidLon) / 2;
		const point = { lat: midLat, lon: midLon, accuracy: 60 };
		expect(snapToPlace(point, [CAFE_A, CAFE_B]).snapped).toBe(false);
		const r = snapToPlace(point, [CAFE_A, CAFE_B], { ambiguityRatio: 1.0 });
		expect(r.snapped).toBe(true);
		expect(r.snappedTo?.id).toBe("cafeA");
	});

	it("returns a clean copy — snapped=false fixes carry through unchanged coords/accuracy", () => {
		const r = snapToPlace({ lat: 0, lon: 0, accuracy: 100 }, [HOME]);
		expect(r).toEqual({ lat: 0, lon: 0, accuracy: 100, snapped: false });
	});
});
