/**
 * Probabilistic place assignment. Replaces the hard-cutoff snap +
 * residential-hours gate with a scorer that combines:
 *
 *   - log-likelihood: Gaussian on the distance from the segment
 *     centroid to a candidate place's centroid, σ = place's
 *     empirical radius.
 *   - log-prior (frequency): how often this place has been visited
 *     before — operationalised as log(unique_days + 1).
 *   - time-of-day match: how well a candidate's mined hour-of-day
 *     dwell profile supports the hours the stay actually spans.
 *     Centred so a uniform — or null (un-mined) — profile scores 0.
 *     This is what routes an evening stay to a residence over a
 *     co-located daytime café when the ~100 m distance term cannot.
 *
 * The picker is a pure function over a list of candidates; the IO
 * (loading focus_places) lives outside.
 */

import { describe, expect, it } from "vitest";
import { type PlaceCandidate, pickBestPlace, scorePlaceForSegment } from "../src/geo/place-prior.js";

/** Equal weight on the given local-solar hours, normalised — a stand-in
 *  for an hour-of-day dwell profile (`focus_places.hour_profile`). */
function profile(hours: number[]): number[] {
	const p = new Array<number>(24).fill(0);
	for (const h of hours) p[h] = 1;
	return p.map((v) => v / hours.length);
}
/** A residence-shaped profile — overnight and evening hours. */
const OVERNIGHT = profile([22, 23, 0, 1, 2, 3, 4, 5, 6, 7]);
/** A café/office-shaped profile — weekday daytime hours. */
const DAYTIME = profile([9, 10, 11, 12, 13, 14, 15, 16, 17]);
/** The profile of a stay that happened overnight / in the daytime. */
const overnightStay = profile([1, 2, 3, 4]);
const daytimeStay = profile([11, 12, 13, 14]);

function home(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
	return {
		id: 1,
		centroidLat: 51.845,
		centroidLon: 5.863,
		radiusM: 80,
		uniqueDays: 200,
		hourProfile: OVERNIGHT,
		...overrides,
	};
}

function workish(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
	return {
		id: 2,
		centroidLat: 51.7,
		centroidLon: 5.6,
		radiusM: 60,
		uniqueDays: 40,
		hourProfile: DAYTIME,
		...overrides,
	};
}

describe("scorePlaceForSegment — distance & frequency", () => {
	const segCentroidAtHome = { lat: 51.846, lon: 5.864 };

	it("scores a near-by place higher than a far-away one (likelihood dominates)", () => {
		const close = scorePlaceForSegment(home(), segCentroidAtHome.lat, segCentroidAtHome.lon, {
			stayHourProfile: daytimeStay,
		});
		const far = scorePlaceForSegment(workish(), segCentroidAtHome.lat, segCentroidAtHome.lon, {
			stayHourProfile: daytimeStay,
		});
		expect(close).toBeGreaterThan(far);
	});

	it("scores a heavily-visited place higher than a one-off, all else equal", () => {
		const veteran = scorePlaceForSegment(home({ uniqueDays: 500 }), 51.845, 5.863, {
			stayHourProfile: overnightStay,
		});
		const newcomer = scorePlaceForSegment(home({ uniqueDays: 1 }), 51.845, 5.863, {
			stayHourProfile: overnightStay,
		});
		expect(veteran).toBeGreaterThan(newcomer);
	});
});

describe("scorePlaceForSegment — time-of-day term", () => {
	// Two candidates at the SAME coordinates, opposite hour-of-day
	// profiles. The distance and frequency terms are identical, so the
	// time-of-day term alone decides — the conflated-cluster case.
	it("an overnight stay scores an overnight-profile place above a co-located daytime-profile place", () => {
		const residence = home({ hourProfile: OVERNIGHT });
		const cafe = home({ id: 9, hourProfile: DAYTIME });
		const resScore = scorePlaceForSegment(residence, 51.845, 5.863, { stayHourProfile: overnightStay });
		const cafeScore = scorePlaceForSegment(cafe, 51.845, 5.863, { stayHourProfile: overnightStay });
		expect(resScore).toBeGreaterThan(cafeScore);
	});

	it("a daytime stay scores a daytime-profile place above a co-located overnight-profile place", () => {
		const residence = home({ hourProfile: OVERNIGHT });
		const cafe = home({ id: 9, hourProfile: DAYTIME });
		const resScore = scorePlaceForSegment(residence, 51.845, 5.863, { stayHourProfile: daytimeStay });
		const cafeScore = scorePlaceForSegment(cafe, 51.845, 5.863, { stayHourProfile: daytimeStay });
		expect(cafeScore).toBeGreaterThan(resScore);
	});

	it("a null (un-mined) profile scores neutrally — between a matching and a mismatching place", () => {
		// A row written before the hour_profile column existed must not
		// out-score a place that genuinely matches, nor lose to one that
		// genuinely mismatches: the time term is centred so null == 0.
		const matching = home({ hourProfile: OVERNIGHT });
		const unmined = home({ id: 8, hourProfile: null });
		const mismatching = home({ id: 9, hourProfile: DAYTIME });
		const opts = { stayHourProfile: overnightStay };
		const matchScore = scorePlaceForSegment(matching, 51.845, 5.863, opts);
		const nullScore = scorePlaceForSegment(unmined, 51.845, 5.863, opts);
		const mismatchScore = scorePlaceForSegment(mismatching, 51.845, 5.863, opts);
		expect(matchScore).toBeGreaterThan(nullScore);
		expect(nullScore).toBeGreaterThan(mismatchScore);
	});

	it("the time-of-day term cannot override strong distance evidence", () => {
		// A perfectly-matching profile 2 km away must lose to the place
		// the user is standing in, even if that place's profile mismatches.
		const standingIn = home({ id: 1, hourProfile: DAYTIME });
		const farMatch = home({ id: 2, centroidLat: 51.863, centroidLon: 5.863, hourProfile: OVERNIGHT });
		const opts = { stayHourProfile: overnightStay };
		const here = scorePlaceForSegment(standingIn, 51.845, 5.863, opts);
		const far = scorePlaceForSegment(farMatch, 51.845, 5.863, opts);
		expect(here).toBeGreaterThan(far);
	});
});

describe("pickBestPlace", () => {
	it("returns null when there are no candidates", () => {
		expect(pickBestPlace([], 51.846, 5.864, { stayHourProfile: daytimeStay })).toBeNull();
	});

	it("picks the only candidate when one is given", () => {
		const r = pickBestPlace([home()], 51.846, 5.864, { stayHourProfile: overnightStay });
		expect(r?.winner.id).toBe(1);
	});

	it("home wins over a faraway focus_place even when fixes are slightly off-centre", () => {
		// 70 m east of home's centroid (within home's 80 m σ).
		const seg = { lat: 51.845, lon: 5.864 };
		const r = pickBestPlace([home(), workish()], seg.lat, seg.lon, { stayHourProfile: overnightStay });
		expect(r?.winner.id).toBe(1);
	});

	it("returns null when no candidate has a usable posterior (all too far)", () => {
		// 5 km from home, even further from work. Beyond any reasonable
		// posterior — caller should fall back to OSM.
		const seg = { lat: 51.9, lon: 5.95 };
		const r = pickBestPlace([home(), workish()], seg.lat, seg.lon, { stayHourProfile: overnightStay });
		expect(r).toBeNull();
	});

	it("regression — May 3 case: 70 m off-centre cluster, only candidate is home → home wins", () => {
		// The actual May 3 cluster centroid lands ~70 m from home's
		// stored centroid. home has 70 m vs radius 80 m → likelihood ≈
		// exp(-0.5 · (70/80)^2) ≈ 0.68 — plenty of signal. Plus the
		// heavy prior on having visited 200 times. Wins comfortably.
		const seg = { lat: 51.8457, lon: 5.8636 };
		const r = pickBestPlace([home()], seg.lat, seg.lon, { stayHourProfile: daytimeStay });
		expect(r?.winner.id).toBe(1);
	});

	it("co-located disambiguation — an evening stay routes to the residence, not the co-located café", () => {
		// The conflated-cluster bug, split into two focus_places: a
		// residence and a café ~0 m apart in this test (distance term
		// cannot separate them). The hour-of-day term must route an
		// overnight stay to the residence.
		const residence = home({ id: 1, hourProfile: OVERNIGHT, uniqueDays: 14 });
		const cafe = home({ id: 2, hourProfile: DAYTIME, uniqueDays: 4 });
		const r = pickBestPlace([cafe, residence], 51.845, 5.863, { stayHourProfile: overnightStay });
		expect(r?.winner.id).toBe(1);
	});

	it("Home/Work no-regression — overnight stay → overnight place, daytime stay → daytime place", () => {
		// Two co-located candidates with opposite profiles must route
		// each kind of stay correctly, as the binary sleep/awake prior
		// did — the hour-of-day term subsumes it.
		const overnightPlace = home({ id: 1, hourProfile: OVERNIGHT });
		const daytimePlace = home({ id: 2, hourProfile: DAYTIME });
		const cands = [overnightPlace, daytimePlace];
		expect(pickBestPlace(cands, 51.845, 5.863, { stayHourProfile: overnightStay })?.winner.id).toBe(1);
		expect(pickBestPlace(cands, 51.845, 5.863, { stayHourProfile: daytimeStay })?.winner.id).toBe(2);
	});

	function oneOff(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
		return {
			id: 70,
			centroidLat: 51.5,
			centroidLon: -0.12,
			radiusM: 25,
			uniqueDays: 1,
			hourProfile: DAYTIME,
			...overrides,
		};
	}
	// 200 m due east of (51.5, -0.12).
	const seg200mEast = { lat: 51.5, lon: -0.12 + 200 / (111_320 * Math.cos((51.5 * Math.PI) / 180)) };

	it("a one-off place does not capture a stay 200 m away", () => {
		// A place visited on a single day has earned no GPS-noise
		// tolerance: a stay 200 m off it is a different place, and
		// pickBestPlace must return null so the caller falls through to
		// a fresh OSM lookup rather than stamp the one-off's mined label
		// on an unrelated stay.
		expect(pickBestPlace([oneOff()], seg200mEast.lat, seg200mEast.lon, { stayHourProfile: daytimeStay })).toBeNull();
	});

	it("a one-off place does not capture a stay ~115 m away (2026-06-18 Ashvale)", () => {
		// A place seen on a single day (15 Feb) claimed a stop 118 m away and
		// stamped its mined "Corner Cafe" label on it. A one-off's reach
		// must stay well under ~100 m — the scale at which a distinct
		// neighbouring place begins — so the stop falls through to a fresh OSM
		// lookup at its own centroid.
		const seg115mEast = { lat: 51.5, lon: -0.12 + 115 / (111_320 * Math.cos((51.5 * Math.PI) / 180)) };
		expect(pickBestPlace([oneOff()], seg115mEast.lat, seg115mEast.lon, { stayHourProfile: daytimeStay })).toBeNull();
	});

	it("an established place still captures a stay within GPS-noise range", () => {
		// Same 200 m offset, but a place visited on many separate days:
		// noise of this size around a well-known place is expected, so
		// the match must hold.
		const established = oneOff({ id: 71, uniqueDays: 60 });
		const r = pickBestPlace([established], seg200mEast.lat, seg200mEast.lon, { stayHourProfile: daytimeStay });
		expect(r?.winner.id).toBe(71);
	});

	it("picks the geographically-closer place even when its prior is much weaker", () => {
		// Demonstrates the likelihood DOES overpower the prior when the
		// distance signal is strong. Home is 1 km off, an unfrequented
		// café is 5 m off.
		const cafe = home({
			id: 50,
			centroidLat: 51.92,
			centroidLon: 5.95,
			radiusM: 40,
			uniqueDays: 2,
			hourProfile: DAYTIME,
		});
		const seg = { lat: 51.92, lon: 5.95 }; // dead-on the café
		const homeAtDistance = home({ centroidLat: 51.91, centroidLon: 5.94 }); // 1.4 km away
		const r = pickBestPlace([homeAtDistance, cafe], seg.lat, seg.lon, { stayHourProfile: daytimeStay });
		expect(r?.winner.id).toBe(50);
	});

	describe("centroid-distance veto", () => {
		// A focus place is a label for stays *inside* the cluster it was
		// mined from. A stay well outside that cluster shouldn't bear the
		// place's name, no matter how strong the priors are — the
		// frequency + hour-of-day terms otherwise let a heavily-visited
		// place win a stay hundreds of metres away. These gates fix that:
		// the picker requires the stay to lie within 3σ of the centroid
		// (where σ is the same Gaussian σ the scorer uses).

		/** 51.5°N: 1° lon ≈ 69 km, so 1 m east ≈ 1 / 69 000 degrees. */
		const M_PER_DEG_LON_AT_51_5 = 111_320 * Math.cos((51.5 * Math.PI) / 180);
		const eastOf = (lat: number, lon: number, dM: number): { lat: number; lon: number } => ({
			lat,
			lon: lon + dM / M_PER_DEG_LON_AT_51_5,
		});

		function workish51_5(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
			return {
				id: 100,
				centroidLat: 51.5,
				centroidLon: -0.13,
				radiusM: 30,
				uniqueDays: 100,
				hourProfile: DAYTIME,
				...overrides,
			};
		}

		it("rejects a heavily-visited focus place when the stay is well outside its cluster", () => {
			// The 2026-05-22 Pizza-Union-as-Work bug: an established place
			// (Work, 100+ days, daytime profile) lying ~420 m away wins on
			// priors despite the distance penalty. The veto must reject it
			// so the caller falls through to the OSM venue lookup.
			const stay = eastOf(51.5, -0.13, 420);
			const r = pickBestPlace([workish51_5()], stay.lat, stay.lon, { stayHourProfile: daytimeStay });
			expect(r).toBeNull();
		});

		it("keeps a stay within ~2σ of the centroid (inside the cluster, with normal GPS noise)", () => {
			// For an established place (100 days), σ floor is ~100 m, so a
			// 180 m offset is well within 2σ. Must be accepted.
			const stay = eastOf(51.5, -0.13, 180);
			const r = pickBestPlace([workish51_5()], stay.lat, stay.lon, { stayHourProfile: daytimeStay });
			expect(r?.winner.id).toBe(100);
		});

		it("veto fires regardless of how strong the priors are", () => {
			// Crank uniqueDays absurdly high and put the profile in perfect
			// alignment — the priors cannot rescue a stay outside the
			// cluster from being mis-labelled.
			const overcooked = workish51_5({ uniqueDays: 10_000 });
			const stay = eastOf(51.5, -0.13, 420);
			const r = pickBestPlace([overcooked], stay.lat, stay.lon, { stayHourProfile: daytimeStay });
			expect(r).toBeNull();
		});

		it("a sparse place has a tighter veto, matching its tighter σ floor", () => {
			// A one-off place sits at the MIN σ floor (40 m): 3σ ≈ 120 m.
			// A 180 m offset is outside that — the veto fires.
			const sparse = workish51_5({ uniqueDays: 1 });
			const stay = eastOf(51.5, -0.13, 180);
			const r = pickBestPlace([sparse], stay.lat, stay.lon, { stayHourProfile: daytimeStay });
			expect(r).toBeNull();
		});

		it("with both a far-cluster and a closer cluster, the closer one wins (veto does not over-fire)", () => {
			// Two candidates: the Work-like cluster 420 m east (would have
			// won on priors before the veto), and a closer one 50 m east
			// of the stay. The closer one is inside its own cluster's
			// tolerance and must be picked.
			const stay = eastOf(51.5, -0.13, 420);
			const near = workish51_5({ id: 101, centroidLat: stay.lat, centroidLon: stay.lon, uniqueDays: 5 });
			const r = pickBestPlace([workish51_5(), near], stay.lat, stay.lon, { stayHourProfile: daytimeStay });
			expect(r?.winner.id).toBe(101);
		});

		it("Pizza-Union-as-Work veto holds even with high biometric coherence", () => {
			// The 2026-05-22 bug must NOT regress when magnet relaxation
			// is added: Work 420 m away is far outside its own magnet
			// radius (≤ 230 m for an established place), so the veto
			// relaxation gate doesn't even apply. Pizza Union (or any
			// stay) outside Work's magnet area still hits the unchanged
			// 3σ veto.
			const stay = eastOf(51.5, -0.13, 420);
			const r = pickBestPlace([workish51_5()], stay.lat, stay.lon, {
				stayHourProfile: daytimeStay,
				biometricCoherence: 1.0,
			});
			expect(r).toBeNull();
		});
	});

	describe("magnetic anchoring", () => {
		// `docs/proposals/2026-06-magnetic-focus-places.md`. The magnet
		// pulls an established focus_place into the lead when a noisy
		// segment centroid drifts toward a co-located OSM POI — but
		// only when biometrics agree the user is actually sitting.

		function varley(overrides: Partial<PlaceCandidate> = {}): PlaceCandidate {
			return {
				id: 50,
				centroidLat: 51.563,
				centroidLon: -0.2796,
				radiusM: 30,
				uniqueDays: 12,
				hourProfile: DAYTIME,
				...overrides,
			};
		}

		// Stay centroid drifted ~70 m east of Varley toward the
		// hypothetical playground node.
		const M_PER_DEG_LON = 111_320 * Math.cos((51.563 * Math.PI) / 180);
		const driftedStay = {
			lat: 51.563,
			lon: -0.2796 + 70 / M_PER_DEG_LON,
		};

		it("boosts a focus_place when the stay's biometrics show resting", () => {
			const sitting = scorePlaceForSegment(varley(), driftedStay.lat, driftedStay.lon, {
				stayHourProfile: daytimeStay,
				biometricCoherence: 0.95,
			});
			const noCoherence = scorePlaceForSegment(varley(), driftedStay.lat, driftedStay.lon, {
				stayHourProfile: daytimeStay,
			});
			// Boost ≈ log(13) · 0.95 ≈ 2.4 log-points — enough to beat a
			// neighbouring POI a few metres closer.
			expect(sitting - noCoherence).toBeGreaterThan(2);
			expect(sitting - noCoherence).toBeLessThan(4);
		});

		it("does NOT boost when biometrics show movement (walking past the place)", () => {
			const walkingPast = scorePlaceForSegment(varley(), driftedStay.lat, driftedStay.lon, {
				stayHourProfile: daytimeStay,
				biometricCoherence: 0.05,
			});
			const noCoherence = scorePlaceForSegment(varley(), driftedStay.lat, driftedStay.lon, {
				stayHourProfile: daytimeStay,
			});
			// Boost ≈ log(13) · 0.05 ≈ 0.13 — negligible.
			expect(walkingPast - noCoherence).toBeLessThan(0.5);
		});

		it("contributes nothing for a one-off place (low magnet strength)", () => {
			const sitting = scorePlaceForSegment(varley({ uniqueDays: 1 }), driftedStay.lat, driftedStay.lon, {
				stayHourProfile: daytimeStay,
				biometricCoherence: 1.0,
			});
			const noCoherence = scorePlaceForSegment(varley({ uniqueDays: 1 }), driftedStay.lat, driftedStay.lon, {
				stayHourProfile: daytimeStay,
			});
			// Boost ≈ log(2) · 1 ≈ 0.7. A small lift, not a dominant
			// term.
			expect(sitting - noCoherence).toBeLessThan(1);
		});

		it("does NOT apply outside the magnet radius", () => {
			// 500 m east of Varley — far outside its magnet (~230 m).
			const farStay = {
				lat: 51.563,
				lon: -0.2796 + 500 / M_PER_DEG_LON,
			};
			const sitting = scorePlaceForSegment(varley(), farStay.lat, farStay.lon, {
				stayHourProfile: daytimeStay,
				biometricCoherence: 1.0,
			});
			const noCoherence = scorePlaceForSegment(varley(), farStay.lat, farStay.lon, {
				stayHourProfile: daytimeStay,
			});
			// No boost at all — the magnet is range-gated.
			expect(sitting).toBe(noCoherence);
		});
	});
});
