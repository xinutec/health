/**
 * 04-29 Vertoef sleep-place — sparse-day regression marker.
 *
 * The 2026-04-29 day ends with a single Vertoef-hotel GPS fix at
 * 21:13 UTC (= 23:13 CEST) after a multi-hour signal gap. Earlier
 * in the day there are multiple fixes at Plein 1944 (central
 * Nijmegen, ~150 m east of Vertoef). The next-day 04-30 morning
 * has one fix at 08:54 UTC, 76 m from Vertoef — together with the
 * 04-29 evening fix, this pair brackets the night sleep at Vertoef.
 *
 * Per the ground-truth narrative (`tests/golden/ground-truth/
 * 2026-04-29.md`, Pippijn-confirmed 2026-05-23), the night sleep
 * happened at Guesthouse Vertoef. The pipeline's ability to anchor
 * the sleep-place label at Vertoef depends on either:
 *
 *   1. classifySegments producing a stationary stay anchored at
 *      the single Vertoef fix (this test), or
 *   2. detectKnownPlaceStays (#189) treating Vertoef as an ad-hoc
 *      known place via OSM lodging-POI lookup, or
 *   3. the sleep-window lodging-POI override (#188) firing at the
 *      sleep centroid before falling back to upstream-stay
 *      inheritance.
 *
 * None of those currently produce Vertoef from the sparse data —
 * the regression flips the sleep label to `Plein 1944 187`. This
 * test pins layer (1): a stationary stay whose centroid sits at
 * Vertoef should survive classification. Pairs with the broader
 * sparse-day failure class tracked under #187.
 *
 * The fixture is gitignored — `describe.skipIf` lets the test pass
 * when it isn't present locally (CI), matching the 2026-04-30
 * pattern in `sparse-day-honest-gaps.test.ts`.
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import { classifySegments, type TrackSegment } from "../../src/geo/segments.js";
import { describeWithFixture } from "../helpers/describe-with-fixture.js";

const FIXTURE_URL = new URL("../fixtures/days/2026-04-29-pippijn.json", import.meta.url);

interface FixturePoint {
	ts: number;
	lat: number;
	lon: number;
	speed_kmh: number;
	bearing: number;
}

interface Fixture {
	points: FixturePoint[];
}

function loadFixture(): Fixture | null {
	try {
		return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;
	} catch {
		return null;
	}
}

const fixture = loadFixture();

// Vertoef = Nassausingel 3, Nijmegen. The single 21:13 UTC fix in
// the fixture lands at (51.84370, 5.85683); the user-confirmed
// guesthouse coordinates per the ground-truth narrative resolve to
// the same building. 100 m radius covers GPS noise around the
// fix.
const VERTOEF_LAT = 51.8437;
const VERTOEF_LON = 5.8569;

// Plein 1944 (central Nijmegen square) — the wrong-answer place
// the regressed pipeline picks. The earlier-day fixes cluster
// here (~150 m east of Vertoef).
const PLEIN_LAT = 51.8454;
const PLEIN_LON = 5.8633;

// UTC window covering the Vertoef arrival + pre-sleep dwell. 22:13
// CEST → 20:13 UTC (the baseline pre-sleep stay start); 23:08 CEST
// → 21:08 UTC (the baseline sleep onset). The actual Vertoef GPS
// fix lands at 21:13 UTC — slightly past the baseline sleep
// onset, but well inside this widened window.
const PRE_SLEEP_WIN_START = Math.floor(new Date("2026-04-29T19:00:00Z").getTime() / 1000);
const PRE_SLEEP_WIN_END = Math.floor(new Date("2026-04-29T22:00:00Z").getTime() / 1000);

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function overlaps(seg: TrackSegment, start: number, end: number): boolean {
	return seg.endTs > start && seg.startTs < end;
}

/** Centroid of the raw fixes that fall inside `seg`'s time window. */
function segmentCentroid(seg: TrackSegment, points: readonly FilteredPoint[]): { lat: number; lon: number } | null {
	const inSeg = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
	if (inSeg.length === 0) return null;
	let latSum = 0;
	let lonSum = 0;
	for (const p of inSeg) {
		latSum += p.lat;
		lonSum += p.lon;
	}
	return { lat: latSum / inSeg.length, lon: lonSum / inSeg.length };
}

describeWithFixture("2026-04-29 Vertoef sleep-place — fixture replay", fixture, (fx) => {
	const filtered: FilteredPoint[] = fx.points.map((p) => ({
		ts: p.ts,
		lat: p.lat,
		lon: p.lon,
		speed_kmh: p.speed_kmh,
		bearing: p.bearing,
	}));

	const segments = classifySegments(filtered);

	// `it.fails` — documents the current sparse-day failure mode
	// without breaking `npm run verify`. Flips to red when the
	// segmentation bug is fixed, prompting marker removal.
	it.fails("produces a stationary stay whose centroid sits at Vertoef in the pre-sleep UTC window", () => {
		const inWindow = segments.filter(
			(s) => s.mode === "stationary" && overlaps(s, PRE_SLEEP_WIN_START, PRE_SLEEP_WIN_END),
		);

		const atVertoef = inWindow.filter((s) => {
			const c = segmentCentroid(s, filtered);
			return c !== null && haversineMeters(c.lat, c.lon, VERTOEF_LAT, VERTOEF_LON) <= 100;
		});

		expect(
			atVertoef.length,
			"a stationary stay anchored at Vertoef must survive classification in 19:00–22:00 UTC of 04-29",
		).toBeGreaterThanOrEqual(1);
	});

	it.fails("does NOT misattribute the pre-sleep window's stay to Plein 1944 area", () => {
		const inWindow = segments.filter(
			(s) => s.mode === "stationary" && overlaps(s, PRE_SLEEP_WIN_START, PRE_SLEEP_WIN_END),
		);

		const onlyAtPlein = inWindow.filter((s) => {
			const c = segmentCentroid(s, filtered);
			if (c === null) return false;
			const dPlein = haversineMeters(c.lat, c.lon, PLEIN_LAT, PLEIN_LON);
			const dVertoef = haversineMeters(c.lat, c.lon, VERTOEF_LAT, VERTOEF_LON);
			return dPlein < 100 && dVertoef > 100;
		});

		expect(
			onlyAtPlein.length,
			"the pre-sleep window must not be filled exclusively by a Plein 1944 stay (the wrong answer)",
		).toBe(0);
	});
});
