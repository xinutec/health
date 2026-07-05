/**
 * Platform-wait absorption.
 *
 * A short stationary segment immediately before a train, sitting at the
 * train's boarding station, is the wait on the platform — it should be
 * folded into the train run, not left as a standalone stay (which the
 * place-assigner then mislabels with the nearest focus place).
 *
 * All coordinates are synthetic, anchored at (50.0, 5.0): station Alpha
 * at the anchor, station Beta 3 km north.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { NearbyStation } from "../src/geo/osm.js";
import { absorbBoardingPlatform, anchorTrainBoardingToWalkedStation } from "../src/geo/passes/rail-absorbers.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

const LAT_DEG_PER_M = 1 / 111_000;
const LON_DEG_PER_M = 1 / (111_000 * Math.cos((50 * Math.PI) / 180));

function at(metresNorth: number, metresEast: number): { lat: number; lon: number } {
	return { lat: 50.0 + metresNorth * LAT_DEG_PER_M, lon: 5.0 + metresEast * LON_DEG_PER_M };
}

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = (lat2 - lat1) / LAT_DEG_PER_M;
	const dLon = (lon2 - lon1) / LON_DEG_PER_M;
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

const STATIONS = [
	{ name: "Alpha", north: 0, east: 0 },
	{ name: "Beta", north: 3000, east: 0 },
	{ name: "Gamma", north: 6000, east: 0 },
];

const stationsLookup = async (lat: number, lon: number): Promise<NearbyStation[]> =>
	STATIONS.map((s) => {
		const p = at(s.north, s.east);
		return { name: s.name, subtype: "subway", distanceM: metres(lat, lon, p.lat, p.lon) };
	})
		.filter((s) => s.distanceM <= 400)
		.sort((a, b) => a.distanceM - b.distanceM);

function seg(
	partial: Partial<EnrichedSegment> & { startTs: number; endTs: number; mode: EnrichedSegment["mode"] },
): EnrichedSegment {
	return {
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		...partial,
	};
}

/** Stationary fixes clustered at a station. */
function fixesAt(station: { north: number; east: number }, fromTs: number, toTs: number): FilteredPoint[] {
	const out: FilteredPoint[] = [];
	for (let ts = fromTs; ts < toTs; ts += 60) {
		out.push({ ...at(station.north, station.east), ts, speed_kmh: 0, bearing: 0 });
	}
	return out;
}

describe("absorbBoardingPlatform", () => {
	it("absorbs a short stationary at the boarding station into the train", async () => {
		const segments = [
			seg({ startTs: 1000, endTs: 1300, mode: "walking" }),
			seg({ startTs: 1300, endTs: 1600, mode: "stationary", place: "Somewhere" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "Alpha → Beta · Line 1" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 1600); // stationary clusters at Alpha
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train"]);
		// The train now starts where the platform wait began.
		expect(result[1].startTs).toBe(1300);
		expect(result[1].endTs).toBe(2200);
		expect(result[1].wayName).toBe("Alpha → Beta · Line 1");
	});

	it("leaves a stationary that resolves to a different station", async () => {
		const segments = [
			seg({ startTs: 1000, endTs: 1300, mode: "walking" }),
			seg({ startTs: 1300, endTs: 1600, mode: "stationary" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "Alpha → Beta · Line 1" }),
		];
		// Stationary sits at Beta, but the train boards at Alpha.
		const points = fixesAt(STATIONS[1], 1300, 1600);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(3);
		expect(result[1].mode).toBe("stationary");
	});

	it("leaves a long stay even at the boarding station", async () => {
		const segments = [
			seg({ startTs: 1000, endTs: 1300, mode: "walking" }),
			seg({ startTs: 1300, endTs: 2500, mode: "stationary" }), // 20 min
			seg({ startTs: 2500, endTs: 3100, mode: "train", wayName: "Alpha → Beta" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 2500);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(3);
		expect(result[1].mode).toBe("stationary");
	});

	it("does nothing when the train has no station-pair wayName", async () => {
		const segments = [
			seg({ startTs: 1300, endTs: 1600, mode: "stationary" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "on subway" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 1600);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(2);
		expect(result[0].mode).toBe("stationary");
	});

	it("does not absorb a walking segment before the train", async () => {
		const segments = [
			seg({ startTs: 1300, endTs: 1600, mode: "walking" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "Alpha → Beta" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 1600);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(2);
		expect(result[0].mode).toBe("walking");
	});
});

describe("anchorTrainBoardingToWalkedStation", () => {
	/** A walk ending in a tight cluster at Alpha, then a fast inter-station hop
	 *  north (the train pulling out of Alpha toward the next station) — the GPS
	 *  the underground reconstruction stranded in the walk. */
	function walkWithBoardingHop(): FilteredPoint[] {
		const out: FilteredPoint[] = [];
		for (let ts = 0; ts <= 240; ts += 60) out.push({ ...at(0, 0), ts, speed_kmh: 3, bearing: 0 }); // at Alpha
		out.push({ ...at(600, 0), ts: 300, speed_kmh: 35, bearing: 0 }); // 600 m N in 60 s = 36 km/h
		out.push({ ...at(1200, 0), ts: 360, speed_kmh: 38, bearing: 0 }); // 1200 m N
		return out;
	}

	it("re-anchors the boarding to the walked-to station and reclaims the hop", async () => {
		const segments = [
			seg({ startTs: 0, endTs: 360, mode: "walking" }),
			seg({ startTs: 420, endTs: 900, mode: "train", wayName: "Beta → Gamma · Line 1" }),
		];
		const result = await anchorTrainBoardingToWalkedStation(segments, walkWithBoardingHop(), stationsLookup);
		expect(result).toHaveLength(2);
		// Boarding rewritten to Alpha (where the walk's cluster sat), line kept.
		expect(result[1].wayName).toBe("Alpha → Gamma · Line 1");
		// Train extended back to the boarding fix (240); walk trimmed to it.
		expect(result[1].startTs).toBe(240);
		expect(result[0].endTs).toBe(240);
		expect(result[0].mode).toBe("walking");
	});

	it("finds the hop even when the surfaced fix settles into a slow one (the real shape)", async () => {
		// The 2026-06-23 pattern: cluster at Alpha, one fast hop to a far point,
		// then a SLOW fix as the train decelerates into the next station. A
		// from-the-end scan misses the hop; the first big+fast step must catch it.
		const fixes: FilteredPoint[] = [];
		for (let ts = 0; ts <= 240; ts += 60) fixes.push({ ...at(0, 0), ts, speed_kmh: 3, bearing: 0 }); // at Alpha
		fixes.push({ ...at(1000, 0), ts: 300, speed_kmh: 38, bearing: 0 }); // 1000 m hop
		fixes.push({ ...at(1020, 0), ts: 360, speed_kmh: 2, bearing: 0 }); // settles (slow) at the far end
		const segments = [
			seg({ startTs: 0, endTs: 360, mode: "walking" }),
			seg({ startTs: 420, endTs: 900, mode: "train", wayName: "Beta → Gamma · Line 1" }),
		];
		const result = await anchorTrainBoardingToWalkedStation(segments, fixes, stationsLookup);
		expect(result[1].wayName).toBe("Alpha → Gamma · Line 1");
		expect(result[1].startTs).toBe(240);
		expect(result[0].endTs).toBe(240);
	});

	it("leaves a plain walk→train (no fast tail) untouched", async () => {
		const segments = [
			seg({ startTs: 0, endTs: 360, mode: "walking" }),
			seg({ startTs: 420, endTs: 900, mode: "train", wayName: "Alpha → Gamma · Line 1" }),
		];
		const slowWalk = [...Array(7)].map((_, i) => ({ ...at(0, i * 10), ts: i * 60, speed_kmh: 3, bearing: 0 }));
		const result = await anchorTrainBoardingToWalkedStation(segments, slowWalk, stationsLookup);
		expect(result[1].wayName).toBe("Alpha → Gamma · Line 1");
		expect(result[1].startTs).toBe(420);
		expect(result[0].endTs).toBe(360);
	});

	it("leaves it untouched when the fix before the hop is not at a station", async () => {
		// Same fast tail, but the pre-hop cluster sits 2 km east — no station within range.
		const far: FilteredPoint[] = [];
		for (let ts = 0; ts <= 240; ts += 60) far.push({ ...at(0, 2000), ts, speed_kmh: 3, bearing: 0 });
		far.push({ ...at(600, 2000), ts: 300, speed_kmh: 35, bearing: 0 });
		far.push({ ...at(1200, 2000), ts: 360, speed_kmh: 38, bearing: 0 });
		const segments = [
			seg({ startTs: 0, endTs: 360, mode: "walking" }),
			seg({ startTs: 420, endTs: 900, mode: "train", wayName: "Beta → Gamma · Line 1" }),
		];
		const result = await anchorTrainBoardingToWalkedStation(segments, far, stationsLookup);
		expect(result[1].wayName).toBe("Beta → Gamma · Line 1");
		expect(result[1].startTs).toBe(420);
	});

	it("leaves a train→sliver-walk→train ride untouched (reconstruction artifact, not a walk-to-station)", async () => {
		// 2026-06-24 Ashvale → Deepwell: one Metropolitan-line ride the
		// underground reconstruction shattered into two train legs with a sliver
		// "walk" between. The walk is bracketed by trains, so its boarding hop is
		// the SAME ride continuing. Re-anchoring leg 2 to a station scanned from the
		// sliver (here: the walk's Alpha cluster) invents a rail-discontinuity —
		// leg 1 alighted Beta, so a leg-2 board at Alpha has no travel between.
		// Continuity is owned by reconcileAdjacentRailLegs / assembleRailJourney;
		// this pass must not fire when a train precedes the walk.
		const segments = [
			seg({ startTs: -540, endTs: 0, mode: "train", wayName: "Zeta → Beta · Line 1" }),
			seg({ startTs: 0, endTs: 360, mode: "walking" }),
			seg({ startTs: 420, endTs: 900, mode: "train", wayName: "Gamma → Delta · Line 1" }),
		];
		const result = await anchorTrainBoardingToWalkedStation(segments, walkWithBoardingHop(), stationsLookup);
		expect(result).toHaveLength(3);
		expect(result[2].wayName).toBe("Gamma → Delta · Line 1");
		expect(result[2].startTs).toBe(420);
		expect(result[1].endTs).toBe(360);
	});
});
