/**
 * splitCluster end-to-end test — runs the cluster-splitting algorithm
 * on real captured focus-cluster data.
 *
 * # Why this test is shaped like this
 *
 * Cluster splitting is a messy-geometry algorithm. Synthetic unit tests
 * (in focus-places.test.ts) run on tidy, deterministic scatter — they
 * cannot exercise the GPS pathologies of a real café + residence that
 * actually decide whether the silhouette / margin gates are tuned
 * right. Rail-snap shipped broken three times with green synthetic
 * tests; cluster splitting has the same exposure.
 *
 * This test runs `splitCluster` against a *real captured cluster*
 * (`capture-focusplaces-fixture.ts` output) and asserts both halves of
 * the proposal's claim: the conflated café + residence cluster splits
 * AND the runtime routes an evening stay to the residence lobe and a
 * daytime stay to the café lobe; while a real Home cluster — one noisy
 * place — does NOT split.
 *
 * The fixture lives in `tests/fixtures/focusplaces/` and is gitignored
 * (real coordinates / times, local only — same policy as
 * `tests/fixtures/railsnap/`). When the fixture is absent — i.e. on CI
 * — every case is skipped. Locally it is the verdict on whether the
 * split works on real data.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type Cluster,
	hourProfileForRange,
	hourProfileOf,
	type Stay,
	splitCluster,
	uniqueDayCount,
} from "../src/geo/focus-places.js";
import { type PlaceCandidate, pickBestPlace } from "../src/geo/place-prior.js";

const FIXTURE_URL = new URL("./fixtures/focusplaces/2026-05-20-pippijn.json", import.meta.url);

interface Fixture {
	schema: string;
	conflated: { note: string; stays: Stay[] };
	home: { note: string; stays: Stay[] } | null;
}

function loadFixture(): Fixture | null {
	try {
		return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;
	} catch {
		return null;
	}
}

/** Build a Cluster from raw stays — dwell-weighted centroid, the same
 *  shape `clusterStays` produces. */
function toCluster(stays: Stay[]): Cluster {
	let dwell = 0;
	let lat = 0;
	let lon = 0;
	for (const s of stays) {
		dwell += s.durationSec;
		lat += s.centroidLat * s.durationSec;
		lon += s.centroidLon * s.durationSec;
	}
	return { id: 1, centroidLat: lat / dwell, centroidLon: lon / dwell, stays, totalDwellSec: dwell };
}

function toCandidate(lobe: Cluster, id: number): PlaceCandidate {
	return {
		id,
		centroidLat: lobe.centroidLat,
		centroidLon: lobe.centroidLon,
		radiusM: 25,
		uniqueDays: uniqueDayCount(lobe.stays, lobe.centroidLon),
		hourProfile: hourProfileOf(lobe),
	};
}

/** Share of an hour-of-day profile that falls in the evening / daytime. */
function eveningMass(p: number[]): number {
	let m = p[0] + p[1];
	for (let h = 17; h <= 23; h++) m += p[h];
	return m;
}
function daytimeMass(p: number[]): number {
	let m = 0;
	for (let h = 10; h <= 16; h++) m += p[h];
	return m;
}

/** The longest stay in a lobe — a representative real visit. */
function longestStay(stays: Stay[]): Stay {
	return [...stays].sort((a, b) => b.durationSec - a.durationSec)[0];
}

const fixture = loadFixture();
const haveFixture = fixture !== null;
const haveHome = fixture?.home != null;

describe("splitCluster E2E — real captured clusters", () => {
	it.skipIf(!haveFixture)("the conflated café + residence cluster splits into a daytime and an evening lobe", () => {
		if (fixture === null) return;
		const lobes = splitCluster(toCluster(fixture.conflated.stays));
		expect(lobes).toHaveLength(2);

		const profiles = lobes.map(hourProfileOf);
		const eveningIdx = eveningMass(profiles[0]) > eveningMass(profiles[1]) ? 0 : 1;
		const cafeIdx = 1 - eveningIdx;
		// One lobe is evening-dominated (the residence), the other
		// daytime-dominated (the café).
		expect(eveningMass(profiles[eveningIdx])).toBeGreaterThan(daytimeMass(profiles[eveningIdx]));
		expect(daytimeMass(profiles[cafeIdx])).toBeGreaterThan(eveningMass(profiles[cafeIdx]));
	});

	it.skipIf(!haveFixture)("routes an evening stay to the residence lobe and a daytime stay to the café lobe", () => {
		if (fixture === null) return;
		const cluster = toCluster(fixture.conflated.stays);
		const lobes = splitCluster(cluster);
		expect(lobes).toHaveLength(2);

		const profiles = lobes.map(hourProfileOf);
		const eveningIdx = eveningMass(profiles[0]) > eveningMass(profiles[1]) ? 0 : 1;
		const cafeIdx = 1 - eveningIdx;
		const residence = toCandidate(lobes[eveningIdx], 1);
		const cafe = toCandidate(lobes[cafeIdx], 2);
		const candidates = [cafe, residence];

		// A representative real stay from each lobe routes to its own
		// place — the integrated distance + time-of-day decision.
		const eveningStay = longestStay(lobes[eveningIdx].stays);
		const daytimeStay = longestStay(lobes[cafeIdx].stays);
		const eveningProfile = hourProfileForRange(eveningStay.startTs, eveningStay.endTs, cluster.centroidLon);
		const daytimeProfile = hourProfileForRange(daytimeStay.startTs, daytimeStay.endTs, cluster.centroidLon);
		expect(
			pickBestPlace(candidates, eveningStay.centroidLat, eveningStay.centroidLon, {
				stayHourProfile: eveningProfile,
			})?.winner.id,
		).toBe(1);
		expect(
			pickBestPlace(candidates, daytimeStay.centroidLat, daytimeStay.centroidLon, {
				stayHourProfile: daytimeProfile,
			})?.winner.id,
		).toBe(2);

		// Stronger: from the MIDPOINT between the two lobe centroids —
		// where the distance term cannot decide — time-of-day alone must
		// route each stay to the right place.
		const midLat = (residence.centroidLat + cafe.centroidLat) / 2;
		const midLon = (residence.centroidLon + cafe.centroidLon) / 2;
		expect(pickBestPlace(candidates, midLat, midLon, { stayHourProfile: eveningProfile })?.winner.id).toBe(1);
		expect(pickBestPlace(candidates, midLat, midLon, { stayHourProfile: daytimeProfile })?.winner.id).toBe(2);
	});

	it.skipIf(!haveHome)("the Home cluster is one noisy place — splitCluster leaves it alone", () => {
		if (fixture?.home == null) return;
		expect(splitCluster(toCluster(fixture.home.stays))).toHaveLength(1);
	});
});
