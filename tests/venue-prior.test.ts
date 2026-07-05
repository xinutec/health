/**
 * Venue-plausibility scoring (task #246).
 *
 * Replaces pickBestLandmark's `type priority − distance/40m` with summed
 * weighted log-evidence per candidate, mirroring the mode factor scorer:
 *
 *   - distance likelihood (−log(d/25), clamped)
 *   - venue-over-area offset (a real venue beats a park/square/way at
 *     comparable distance, but not across a large distance gap)
 *   - visit-shape prior: P(type) × P(dwell bucket | type) × P(hour | type),
 *     MINED from the user's own stay history (never hand-tuned numbers) with
 *     subtype → category → uniform backoff
 *   - opening-hours evidence (open fraction during the stay; absence of the
 *     tag is NO evidence, weighted so stale OSM hours can be out-voted)
 *   - never-a-destination subtypes (street furniture: post boxes, vending
 *     machines, benches) are excluded outright — the one binary rule, kept
 *     to objects that have no premises to be "at"
 *
 * The motivating day: a 74-minute 19:00 sit must resolve to the restaurant
 * at 32 m, not the (closed, errand-shaped) pharmacy at 18 m; and when no
 * venue is plausible the area label must win — honest beats least-wrong.
 *
 * All venues, coordinates and histories below are synthetic.
 */

import { describe, expect, it } from "vitest";
import type { NearbyLandmark } from "../src/geo/osm.js";
import {
	attributeStayVenue,
	categoryOfSubtype,
	dwellBucket,
	minePriors,
	NEVER_DESTINATION_SUBTYPES,
	rankVenues,
	type VenuePriors,
} from "../src/geo/venue-prior.js";

// --- helpers -------------------------------------------------------------

function venue(name: string, subtype: string, distanceM: number, openingHours?: string): NearbyLandmark {
	const type = subtype === "hotel" ? "tourism" : subtype === "clothes" ? "shop" : "amenity";
	return { name, type, subtype, distanceM, openingHours };
}

function area(name: string, distanceM: number): NearbyLandmark {
	return { name, type: "leisure", subtype: "park", distanceM };
}

/** Build per-type stats: visits spread over one dwell bucket + hour range. */
function stats(visits: number, bucket: number, hourFrom: number, hourTo: number) {
	const dwell = [0, 0, 0, 0];
	dwell[bucket] = visits;
	const hours = new Array(24).fill(0);
	const span = hourTo - hourFrom;
	for (let h = hourFrom; h < hourTo; h++) hours[h] = visits / span;
	return { visits, dwell, hours };
}

/** A synthetic history: lots of meal-length food visits (midday + evening),
 *  a few short daytime errands. */
function foodHeavyPriors(): VenuePriors {
	return {
		bySubtype: {
			restaurant: stats(40, 2, 12, 22),
			cafe: stats(20, 1, 9, 17),
			pharmacy: stats(3, 0, 10, 17),
		},
		byCategory: {
			food: stats(60, 2, 9, 22),
			errand: stats(5, 0, 9, 18),
		},
		totalVisits: 65,
	};
}

// Tuesday 2026-06-09, Europe/London (BST = UTC+1): 19:03–20:17 local.
const DINNER = {
	startUnix: Date.UTC(2026, 5, 9, 18, 3) / 1000,
	endUnix: Date.UTC(2026, 5, 9, 19, 17) / 1000,
	tz: "Europe/London",
};

// --- structure -----------------------------------------------------------

describe("categoryOfSubtype", () => {
	it("maps common subtypes to their dwell-shape pools", () => {
		expect(categoryOfSubtype("restaurant")).toBe("food");
		expect(categoryOfSubtype("pub")).toBe("food");
		expect(categoryOfSubtype("hotel")).toBe("lodging");
		expect(categoryOfSubtype("pharmacy")).toBe("errand");
		expect(categoryOfSubtype("hairdresser")).toBe("errand");
		expect(categoryOfSubtype("hospital")).toBe("institution");
		expect(categoryOfSubtype("cinema")).toBe("leisure");
	});

	it("maps unknown subtypes to other", () => {
		expect(categoryOfSubtype("hackerspace_zoo")).toBe("other");
	});
});

describe("dwellBucket", () => {
	it("buckets errand / short / meal / long dwells", () => {
		expect(dwellBucket(5 * 60)).toBe(0);
		expect(dwellBucket(25 * 60)).toBe(1);
		expect(dwellBucket(74 * 60)).toBe(2);
		expect(dwellBucket(5 * 3600)).toBe(3);
	});
});

// --- ranking, context-free (parity with the old picker's pinned behavior) -

describe("rankVenues without stay context", () => {
	it("prefers a venue over an area at the same distance", () => {
		const r = rankVenues([area("Town Square", 50), venue("Trattoria", "restaurant", 50)], null, null);
		expect(r[0].landmark.name).toBe("Trattoria");
	});

	it("prefers the closer venue among equals", () => {
		const r = rankVenues([venue("Far Cafe", "cafe", 90), venue("Near Trattoria", "restaurant", 20)], null, null);
		expect(r[0].landmark.name).toBe("Near Trattoria");
	});

	it("does not let a far venue beat the park the stay sits in", () => {
		const r = rankVenues([venue("Distant Cafe", "cafe", 95), area("Adjacent Park", 5)], null, null);
		expect(r[0].landmark.name).toBe("Adjacent Park");
	});

	it("still prefers a venue only slightly farther than the park", () => {
		const r = rankVenues([venue("Corner Cafe", "cafe", 30), area("Small Park", 10)], null, null);
		expect(r[0].landmark.name).toBe("Corner Cafe");
	});

	it("puts shop and amenity venues on equal footing (distance decides)", () => {
		// #173: the old type table ranked shop below amenity categorically.
		const r = rankVenues([venue("Bookshop", "clothes", 12), venue("Cafe", "cafe", 35)], null, null);
		expect(r[0].landmark.name).toBe("Bookshop");
	});

	it("an enclosing institution outranks everything", () => {
		const hospital: NearbyLandmark = {
			name: "City Hospital",
			type: "amenity",
			subtype: "hospital",
			distanceM: 55,
			enclosing: true,
		};
		const r = rankVenues([venue("Corner Cafe", "cafe", 8), hospital], null, null);
		expect(r[0].landmark.name).toBe("City Hospital");
	});
});

// --- near-field distance dominance ---------------------------------------

// A short late-morning sit, like the 2026-06-17 GP appointment (15 min, 11:13).
const GP_VISIT = {
	startUnix: Date.UTC(2026, 5, 17, 10, 13) / 1000,
	endUnix: Date.UTC(2026, 5, 17, 10, 28) / 1000,
	tz: "Europe/London",
};

describe("near-field distance dominance", () => {
	it("a venue you are sitting on (≤12 m) beats a farther one despite food-heavy history (the GP case)", () => {
		// Bloomsbury Surgery 8 m vs Project68 cafe 28 m. Food-heavy history
		// (no doctor visits) used to hand the café the win; a venue you are
		// 8 m from is where you are.
		const r = rankVenues(
			[venue("Project68", "cafe", 28), venue("Bloomsbury Surgery", "doctors", 8)],
			GP_VISIT,
			foodHeavyPriors(),
		);
		expect(r[0].landmark.name).toBe("Bloomsbury Surgery");
	});

	it("picks the nearest of two near-field venues", () => {
		const r = rankVenues([venue("Doctors", "doctors", 10), venue("Clinic", "clinic", 6)], GP_VISIT, foodHeavyPriors());
		expect(r[0].landmark.name).toBe("Clinic");
	});

	it("does NOT fire beyond 12 m — an ambiguous mid-field sit still uses the prior", () => {
		// At 20 m vs 28 m neither is "sat upon"; the café's shape prior may
		// legitimately break the tie. Near-field must not reach this far.
		const r = rankVenues(
			[venue("Project68", "cafe", 28), venue("Bloomsbury Surgery", "doctors", 20)],
			GP_VISIT,
			foodHeavyPriors(),
		);
		expect(r[0].landmark.name).toBe("Project68");
	});

	it("an enclosing institution still outranks a near-field point venue", () => {
		const hospital: NearbyLandmark = {
			name: "City Hospital",
			type: "amenity",
			subtype: "hospital",
			distanceM: 55,
			enclosing: true,
		};
		const r = rankVenues([venue("Corner Cafe", "cafe", 8), hospital], GP_VISIT, foodHeavyPriors());
		expect(r[0].landmark.name).toBe("City Hospital");
	});

	it("does NOT grant near-field to a reverse-geocode candidate (distance 0 by construction)", () => {
		// A Nominatim reverse-geocode result has distanceM 0 because Nominatim
		// placed the query INSIDE the building — not a measured proximity. It
		// must not get the near-field shortcut, so a genuinely-measured nearby
		// venue still wins it. Without the `reverseGeocoded` exclusion the
		// distance-0 candidate would dominate every other POI.
		const reverseGeocoded: NearbyLandmark = {
			name: "Reverse-Geocoded Bistro",
			type: "amenity",
			subtype: "restaurant",
			distanceM: 0,
			reverseGeocoded: true,
		};
		const r = rankVenues([reverseGeocoded, venue("Measured Clinic", "clinic", 8)], GP_VISIT, foodHeavyPriors());
		expect(r[0].landmark.name).toBe("Measured Clinic");
	});
});

// --- never-a-destination -------------------------------------------------

describe("never-a-destination filter", () => {
	it("contains only premises-less street furniture", () => {
		expect(NEVER_DESTINATION_SUBTYPES.has("post_box")).toBe(true);
		expect(NEVER_DESTINATION_SUBTYPES.has("vending_machine")).toBe(true);
		// Things with premises (however unlikely as a long stay) stay
		// weighted, not filtered: weight, don't filter.
		expect(NEVER_DESTINATION_SUBTYPES.has("charging_station")).toBe(false);
		expect(NEVER_DESTINATION_SUBTYPES.has("parking")).toBe(false);
	});

	it("never labels a stay with a post box, however close", () => {
		const postBox: NearbyLandmark = { name: "SW1 123", type: "amenity", subtype: "post_box", distanceM: 3 };
		const r = rankVenues([postBox, venue("Trattoria", "restaurant", 40)], null, null);
		expect(r[0].landmark.name).toBe("Trattoria");
		expect(r.some((c) => c.landmark.subtype === "post_box")).toBe(false);
	});

	it("falls back to the unfiltered list when everything is street furniture", () => {
		const postBox: NearbyLandmark = { name: "SW1 123", type: "amenity", subtype: "post_box", distanceM: 3 };
		const r = rankVenues([postBox], null, null);
		expect(r).toHaveLength(1);
	});
});

// --- mined visit-shape prior ----------------------------------------------

describe("rankVenues with stay shape + mined priors", () => {
	it("resolves a meal-length evening sit to the restaurant, not the closer errand venue", () => {
		const r = rankVenues(
			[venue("Corner Pharmacy", "pharmacy", 18), venue("Trattoria", "restaurant", 32)],
			DINNER,
			foodHeavyPriors(),
		);
		expect(r[0].landmark.name).toBe("Trattoria");
	});

	it("without priors the same pair falls back to distance (pharmacy wins)", () => {
		const r = rankVenues(
			[venue("Corner Pharmacy", "pharmacy", 18), venue("Trattoria", "restaurant", 32)],
			DINNER,
			null,
		);
		expect(r[0].landmark.name).toBe("Corner Pharmacy");
	});

	it("backs off through category for an unmined subtype", () => {
		// "bistro" has no per-subtype history, but its category (food) is
		// well represented — it must still beat the errand venue for a
		// dinner-shaped sit.
		const priors = foodHeavyPriors();
		const r = rankVenues([venue("Corner Pharmacy", "pharmacy", 18), venue("Chez Synth", "bistro", 32)], DINNER, priors);
		expect(r[0].landmark.name).toBe("Chez Synth");
	});

	it("does not let the prior overrule a decisive distance gap", () => {
		// The restaurant prior is strong, but 250 m vs 8 m is not a
		// labelling ambiguity — the user is at the pharmacy's building.
		const r = rankVenues(
			[venue("Corner Pharmacy", "pharmacy", 8), venue("Trattoria", "restaurant", 250)],
			DINNER,
			foodHeavyPriors(),
		);
		expect(r[0].landmark.name).toBe("Corner Pharmacy");
	});

	it("handles empty priors without NaN", () => {
		const empty: VenuePriors = { bySubtype: {}, byCategory: {}, totalVisits: 0 };
		const r = rankVenues([venue("Trattoria", "restaurant", 32)], DINNER, empty);
		expect(Number.isFinite(r[0].total)).toBe(true);
	});
});

// --- mining: unambiguous attribution + aggregation -------------------------

describe("attributeStayVenue", () => {
	it("attributes a stay to the single close venue", () => {
		const r = attributeStayVenue([venue("Trattoria", "restaurant", 12), area("Park", 40)]);
		expect(r?.name).toBe("Trattoria");
	});

	it("returns null when two venues are both close (ambiguous)", () => {
		// The ambiguous cases are exactly what the scorer must PREDICT —
		// training on them would launder the old picker's mistakes into
		// the prior (the feedback-loop trap).
		const r = attributeStayVenue([venue("Trattoria", "restaurant", 12), venue("Corner Pharmacy", "pharmacy", 25)]);
		expect(r).toBeNull();
	});

	it("returns null when the nearest venue is too far to be certain", () => {
		expect(attributeStayVenue([venue("Trattoria", "restaurant", 45)])).toBeNull();
	});

	it("ignores street furniture and areas when judging ambiguity", () => {
		const postBox: NearbyLandmark = { name: "SW1 1", type: "amenity", subtype: "post_box", distanceM: 5 };
		const r = attributeStayVenue([postBox, area("Park", 14), venue("Trattoria", "restaurant", 12)]);
		expect(r?.name).toBe("Trattoria");
	});
});

describe("minePriors", () => {
	it("aggregates attributed stays into subtype + category histograms", () => {
		const priors = minePriors([
			{ subtype: "restaurant", durationSec: 74 * 60, localHour: 19 },
			{ subtype: "restaurant", durationSec: 50 * 60, localHour: 13 },
			{ subtype: "cafe", durationSec: 25 * 60, localHour: 10 },
			{ subtype: "pharmacy", durationSec: 6 * 60, localHour: 11 },
		]);
		expect(priors.totalVisits).toBe(4);
		expect(priors.bySubtype.restaurant.visits).toBe(2);
		expect(priors.bySubtype.restaurant.dwell[2]).toBe(2); // both meal-length
		expect(priors.bySubtype.restaurant.hours[19]).toBe(1);
		expect(priors.byCategory.food?.visits).toBe(3); // restaurant + cafe
		expect(priors.byCategory.errand?.visits).toBe(1);
	});

	it("produces a blob the scorer accepts end-to-end", () => {
		const priors = minePriors(
			Array.from({ length: 30 }, (_, i) => ({
				subtype: "restaurant",
				durationSec: 80 * 60,
				localHour: i % 2 === 0 ? 13 : 19,
			})),
		);
		const r = rankVenues(
			[venue("Corner Pharmacy", "pharmacy", 18), venue("Trattoria", "restaurant", 32)],
			DINNER,
			priors,
		);
		expect(r[0].landmark.name).toBe("Trattoria");
	});
});

// --- opening-hours evidence -----------------------------------------------

describe("rankVenues with opening hours", () => {
	it("prefers the open restaurant over a closer closed one", () => {
		const r = rankVenues(
			[
				venue("Closed Bistro", "restaurant", 15, "Mo-Fr 09:00-17:00"),
				venue("Open Trattoria", "restaurant", 35, "Mo-Su 12:00-23:00"),
			],
			DINNER,
			null,
		);
		expect(r[0].landmark.name).toBe("Open Trattoria");
	});

	it("treats an unparseable or missing tag as no evidence", () => {
		const r = rankVenues(
			[venue("Sunrise Cafe", "cafe", 20, "sunrise-sunset"), venue("Untagged Cafe", "cafe", 20)],
			DINNER,
			null,
		);
		// Neither candidate gains or loses: ordering falls to the stable
		// tie-break, and both totals are equal.
		expect(r[0].total).toBeCloseTo(r[1].total, 6);
	});

	it("being open is weak evidence, being closed is strong", () => {
		const open = rankVenues([venue("Open", "cafe", 20, "Mo-Su 00:00-24:00")], DINNER, null)[0];
		const closed = rankVenues([venue("Closed", "cafe", 20, "Mo-Fr 02:00-03:00")], DINNER, null)[0];
		const neutral = rankVenues([venue("Untagged", "cafe", 20)], DINNER, null)[0];
		expect(open.total - neutral.total).toBeGreaterThan(0);
		expect(open.total - neutral.total).toBeLessThan(1);
		expect(neutral.total - closed.total).toBeGreaterThan(1.5);
	});

	it("lets the area label win when every venue is implausible", () => {
		// Honest fallback: one distant closed venue vs the square the stay
		// is on — the square must win rather than the least-wrong venue.
		const r = rankVenues(
			[venue("Closed Bistro", "restaurant", 80, "Mo-Fr 09:00-17:00"), area("Station Square", 12)],
			DINNER,
			null,
		);
		expect(r[0].landmark.name).toBe("Station Square");
	});
});
