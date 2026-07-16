import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/velocity.js";
import type { HmmSegment } from "../src/hmm/persist.js";
import { applyHsmmPlaceOverride } from "../src/hmm/place-override.js";

/**
 * `applyHsmmPlaceOverride` is the integration glue between the
 * HSMM's place picks (from `decoded_days`) and the heuristic
 * pipeline's segments. For each pipeline stationary segment, it
 * finds the dominant HSMM placeId across the segment's minutes and
 * overrides the segment's `place` display name when the HSMM is
 * confident.
 *
 * Pure function — tested with synthetic segments + name lookup
 * tables, no DB or live data.
 */

const MIN = 60;
const TS = 1_716_000_000;

function stationary(startMin: number, endMin: number, place: string | null): EnrichedSegment {
	return {
		startTs: TS + startMin * MIN,
		endTs: TS + endMin * MIN,
		mode: "stationary",
		pointCount: 0,
		distM: 0,
		avgSpeed: 0,
		maxSpeed: 0,
		avgKmh: 0,
		maxKmh: 0,
		confidence: 1,
		confidenceMargin: 0,
		linearity: 0,
		place: place ?? undefined,
	} as unknown as EnrichedSegment;
}

function moving(startMin: number, endMin: number, mode: string): EnrichedSegment {
	return {
		startTs: TS + startMin * MIN,
		endTs: TS + endMin * MIN,
		mode,
		pointCount: 0,
		distM: 0,
		avgSpeed: 5,
		maxSpeed: 5,
		avgKmh: 5,
		maxKmh: 5,
		confidence: 1,
		confidenceMargin: 0,
		linearity: 0,
	} as unknown as EnrichedSegment;
}

function hsmm(startMin: number, endMin: number, mode: HmmSegment["mode"], placeId: number | null = null): HmmSegment {
	return {
		startTs: TS + startMin * MIN,
		endTs: TS + endMin * MIN,
		mode,
		placeId,
		lineName: null,
	};
}

function hsmmTrain(startMin: number, endMin: number, lineName: string | null): HmmSegment {
	return {
		startTs: TS + startMin * MIN,
		endTs: TS + endMin * MIN,
		mode: "train",
		placeId: null,
		lineName,
	};
}

const PLACES = new Map<number, { displayName: string | null }>([
	[1, { displayName: "Home" }],
	[2, { displayName: "Cleveland Clinic London" }],
	[3, { displayName: null }], // place with no display name (just an id)
	// Clusters that qualify for the "Stay" bucket in
	// `assignDisplayNames` — overnight presence but not Home/Work
	// territory. The string `"Stay"` is a clustering category, not a
	// venue label; the pipeline's `bestPlace` lookup already attached
	// a venue name and the override must not overwrite it.
	[4, { displayName: "Stay" }],
]);

describe("applyHsmmPlaceOverride", () => {
	it("returns segments unchanged when no HSMM segments overlap", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm: HmmSegment[] = [];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out).toEqual(segments);
	});

	it("overrides a stationary segment's place when HSMM dominant is a different known place", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 2)]; // Cleveland Clinic
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Cleveland Clinic London");
	});

	it("leaves a stationary segment alone when HSMM agrees", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 1)]; // Home
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
	});

	it("does not override when HSMM dominant placeId is null (off-network)", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", null)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		// Pipeline picked Home; HSMM was uncertain about place. Trust pipeline.
		expect(out[0].place).toBe("Home");
	});

	it("does not override when HSMM thinks the segment is NOT stationary", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "walking")];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
	});

	it("only overrides stationary segments — walking is untouched", () => {
		const segments = [moving(0, 60, "walking")];
		const hmm = [hsmm(0, 60, "stationary", 2)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].mode).toBe("walking");
		expect(out[0].place).toBeUndefined();
	});

	it("picks the HSMM placeId with majority overlap minutes", () => {
		const segments = [stationary(0, 60, "Home")];
		// HSMM split: 20 min Cleveland Clinic, 40 min Home → Home wins.
		const hmm = [hsmm(0, 20, "stationary", 2), hsmm(20, 60, "stationary", 1)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
	});

	it("skips override when the dominant placeId has no display_name", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 3)]; // place #3 has display_name=null
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		// Can't surface "#3" as a human label — keep pipeline's.
		expect(out[0].place).toBe("Home");
	});

	it("skips override when the focus_place's displayName is the generic 'Stay' bucket", () => {
		// Cleveland Clinic on 2026-05-22: pipeline ran bestPlace and
		// attached "Cleveland Clinic London" from OSM. HSMM picked the
		// (8-night) cluster whose displayName is "Stay" in the mining
		// bucket sense. The override must NOT overwrite the venue name
		// with the bucket label — `velocity.ts:1014` already treats
		// "Stay" as a placeholder that needs an OSM re-resolve.
		const segments = [stationary(0, 60, "Cleveland Clinic London")];
		const hmm = [hsmm(0, 60, "stationary", 4)]; // placeId 4 → displayName="Stay"
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Cleveland Clinic London");
	});

	it("skips override when seg.place is undefined AND HSMM's displayName is 'Stay'", () => {
		// Defensive: even if the pipeline failed to attach a venue
		// name (bestPlace returned null), surfacing "@ Stay" is
		// worse than surfacing "stationary" with no place — the
		// generic bucket label is misleading as a venue.
		const segments = [stationary(0, 60, null)];
		const hmm = [hsmm(0, 60, "stationary", 4)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBeUndefined();
	});

	it("handles multiple stationary segments independently", () => {
		const segments = [stationary(0, 60, "Home"), moving(60, 90, "walking"), stationary(90, 180, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 1), hsmm(60, 90, "walking"), hsmm(90, 180, "stationary", 2)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
		expect(out[2].place).toBe("Cleveland Clinic London");
	});

	it("overrides driving → train when HSMM has a confident train pick on a movement segment", () => {
		// Pipeline mislabels a tube ride as driving (the 2026-05-22
		// 20:05 Deepwell Underpass case). HSMM picked `train @ Met`.
		// The override rewrites mode to train and wayName to the
		// HSMM line.
		const segments = [moving(0, 13, "driving")];
		(segments[0] as { avgSpeed: number }).avgSpeed = 23;
		const hmm = [hsmmTrain(0, 13, "Metropolitan Line")];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].mode).toBe("train");
		expect(out[0].wayName).toBe("Metropolitan Line");
	});

	it("clears a stale vehicleKind:'bus' when overriding to train (#365)", () => {
		// The bus-evidence pass judges a leg while it is still an
		// unidentified driving placeholder; a sub-surface tube under a
		// main road shows the same stop geometry as a bus, so it stamps
		// vehicleKind:"bus". The train override supersedes that whole
		// road-vehicle interpretation — leaving vehicleKind behind lets
		// the day-state flattening render a "bus" named after a tube
		// line (vehicleKind outranks refinedMode there).
		const segments = [moving(0, 6, "driving")];
		(segments[0] as { avgSpeed: number }).avgSpeed = 23;
		(segments[0] as { vehicleKind?: "bus" }).vehicleKind = "bus";
		const hmm = [hsmmTrain(0, 6, "Metropolitan Line")];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].mode).toBe("train");
		expect(out[0].vehicleKind).toBeUndefined();
	});

	it("does NOT override slow-walk → train (the user is walking to the tube, not riding it yet)", () => {
		// 19:55-20:04 on 2026-05-22: pipeline says walking @ 1.8 km/h
		// to Pentonville Road tube entrance. HSMM picked train @ Met
		// for the bookend but the user was walking. Min-speed guard
		// prevents the over-aggressive flip.
		const segments = [moving(0, 9, "walking")];
		(segments[0] as { avgSpeed: number }).avgSpeed = 1.8;
		const hmm = [hsmmTrain(0, 9, "Metropolitan Line")];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].mode).toBe("walking");
	});

	it("does NOT override mode when pipeline already says train (avoids losing pipeline's line attribution)", () => {
		// Pipeline says train · Jubilee; HSMM says train · Met (wrong
		// line, right mode). Trust pipeline's line — it has finer-
		// grained station knowledge than the route graph yet.
		const segments = [moving(0, 9, "train")];
		segments[0].wayName = "Carfax → Farvale · Jubilee Line";
		const hmm = [hsmmTrain(0, 9, "Metropolitan Line")];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].wayName).toBe("Carfax → Farvale · Jubilee Line");
	});

	it("does NOT override walking → train without explicit train evidence (HSMM unknown_rail does not fire)", () => {
		const segments = [moving(0, 13, "walking")];
		const hmm = [hsmmTrain(0, 13, "unknown_rail")];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].mode).toBe("walking");
	});

	it("does not mutate input arrays or segment objects", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 2)];
		const originalPlace = segments[0].place;
		applyHsmmPlaceOverride(segments, hmm, PLACES);
		// Input is unchanged after the call.
		expect(segments[0].place).toBe(originalPlace);
	});
});

// Elmford office vs Home (Ashvale) — ~13 km apart. The British
// Library café sits ~400 m from the office: a legitimate nearby refinement.
const KX = { lat: 51.533, lon: -0.126 };
const HOME_ASHVALE = { lat: 51.5628, lon: -0.278 };
const PLACES_GEO = new Map<number, { displayName: string | null; lat?: number | null; lon?: number | null }>([
	[1, { displayName: "Home", lat: HOME_ASHVALE.lat, lon: HOME_ASHVALE.lon }],
	[10, { displayName: "Work", lat: KX.lat, lon: KX.lon }],
	[11, { displayName: "British Library Café", lat: 51.5298, lon: -0.1276 }],
]);

function stationaryGeo(
	startMin: number,
	endMin: number,
	place: string | null,
	lat: number,
	lon: number,
): EnrichedSegment {
	const s = stationary(startMin, endMin, place) as EnrichedSegment & { centroidLat: number; centroidLon: number };
	s.centroidLat = lat;
	s.centroidLon = lon;
	return s;
}

describe("applyHsmmPlaceOverride — doorstep-consistency gate (#244)", () => {
	it("refuses an override whose place is geographically inconsistent with the stay's own GPS", () => {
		// 2026-06-22: a 6.8h office stay at Elmford, GPS-present at both
		// ends but dark for ~4.5h in the middle. The decoder fills the dark
		// interior with the Home prior; the majority-overlap override would
		// teleport the whole stay ~13 km to Home. The stay's own GPS centroid
		// pins it to Elmford — refuse, keep the pipeline's place.
		const seg = stationaryGeo(0, 408, "Work", KX.lat, KX.lon);
		const hmm = [hsmm(0, 408, "stationary", 1)]; // dominant = Home (Ashvale)
		const out = applyHsmmPlaceOverride([seg], hmm, PLACES_GEO);
		expect(out[0].place).toBe("Work");
	});

	it("still applies a nearby override — a real refinement, not a teleport", () => {
		const seg = stationaryGeo(0, 60, "Work", KX.lat, KX.lon);
		const hmm = [hsmm(0, 60, "stationary", 11)]; // ~400 m away
		const out = applyHsmmPlaceOverride([seg], hmm, PLACES_GEO);
		expect(out[0].place).toBe("British Library Café");
	});

	it("does not gate when the stay has no GPS centroid — a truly dark stay anchors via the prior", () => {
		// A fully GPS-null stay (overnight, no fixes) has no centroid to
		// contradict; the continuity / visit-frequency prior legitimately
		// assigns the place. The gate must not fire without a centroid.
		const seg = stationary(0, 60, "Work"); // no centroidLat/Lon
		const hmm = [hsmm(0, 60, "stationary", 1)]; // Home
		const out = applyHsmmPlaceOverride([seg], hmm, PLACES_GEO);
		expect(out[0].place).toBe("Home");
	});
});
