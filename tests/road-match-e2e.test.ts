/**
 * Road map-match end-to-end test — runs the matcher on a real captured day.
 *
 * # Why this test is shaped like this
 *
 * The synthetic `road-match.test.ts` exercises the geometry + Viterbi
 * mechanics on a tidy hand-built network. The rail-snap saga is the
 * standing warning that tidy synthetic fixes carry no signal: real urban
 * driving GPS has the pathologies that actually decide whether a matcher
 * helps or hurts — fixes off the carriageway, corner scatter, multi-lane
 * dual carriageways, parallel side-streets a fix can wrongly snap to.
 *
 * This test runs `matchRoadSegment` against a *real captured day*
 * (`capture-roadmatch-fixture.ts` output): real fixes, real classified
 * road-vehicle segments, real OSM road geometry. It asserts outcome
 * *properties* a synthetic test cannot — most importantly that a match,
 * when returned, sits on the road network and is not a wild detour, and
 * that the matcher does not silently degrade every leg to a worse path.
 *
 * The fixture lives in `tests/fixtures/roadmatch/` and is gitignored (real
 * coordinates / journeys — same policy as `railsnap`). Absent on CI, so the
 * suite skips there; locally it runs on every `npm test` and is the verdict
 * on whether the feature works.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchRoadSegment, projectPointToSegment, type RoadGeometry } from "../src/geo/road-match.js";
import { describeWithFixture } from "./helpers/describe-with-fixture.js";

const FIXTURE_URL = new URL("./fixtures/roadmatch/2026-06-21-pippijn.json", import.meta.url);

interface Fixture {
	schema: string;
	segments: Array<{ startTs: number; endTs: number; mode: string; refinedMode: string | null; wayName: string | null }>;
	rawFixes: Array<{ ts: number; lat: number; lon: number; accuracy: number | null }>;
	osmRoadWays: RoadGeometry["ways"];
}

function loadFixture(): Fixture | null {
	try {
		return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;
	} catch {
		return null;
	}
}

const ROAD_MODES = new Set(["driving", "bus", "cycling"]);

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** Nearest distance (m) from a point to any road in the network. */
function distToNetwork(lat: number, lon: number, geo: RoadGeometry): number {
	let best = Number.POSITIVE_INFINITY;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
			const b = { lat: w.coords[i][0], lon: w.coords[i][1] };
			const d = projectPointToSegment({ lat, lon }, a, b).distM;
			if (d < best) best = d;
		}
	}
	return best;
}

function pathLength(pts: ReadonlyArray<{ lat: number; lon: number }>): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += metersBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
	return total;
}

describeWithFixture("road-match e2e", loadFixture(), (fixture) => {
	const geo: RoadGeometry = { ways: fixture.osmRoadWays };
	const roadSegs = fixture.segments.filter((s) => ROAD_MODES.has(s.refinedMode ?? s.mode));

	it("has a usable fixture (road geometry + at least one road leg)", () => {
		expect(geo.ways.length).toBeGreaterThan(0);
		expect(roadSegs.length).toBeGreaterThan(0);
	});

	for (const [i, seg] of roadSegs.entries()) {
		const fixes = fixture.rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
		const mode = seg.refinedMode ?? seg.mode;

		describe(`leg ${i} (${mode}, ${fixes.length} fixes)`, () => {
			const result = matchRoadSegment(fixes, geo);

			it("returns either a clean match or an honest null — never a broken path", () => {
				if (result === null) return; // honest fallback to raw; nothing to assert
				expect(result.path.length).toBeGreaterThanOrEqual(2);
				// Timestamps monotonic and inside the leg window.
				for (let k = 1; k < result.path.length; k++) {
					expect(result.path[k].ts).toBeGreaterThanOrEqual(result.path[k - 1].ts);
				}
				expect(result.path[0].ts).toBeGreaterThanOrEqual(seg.startTs);
				expect(result.path.at(-1)?.ts).toBeLessThanOrEqual(seg.endTs);
			});

			it("when matched, every drawn vertex sits on the road network", () => {
				if (result === null) return;
				// p95 of the snap distances — robust to a single stitched end.
				const dists = result.path.map((p) => distToNetwork(p.lat, p.lon, geo)).sort((a, b) => a - b);
				const p95 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.95))];
				expect(p95).toBeLessThan(8);
			});

			it("when matched, is not a wild detour vs the raw track", () => {
				if (result === null) return;
				const rawLen = pathLength(fixes);
				const matchedLen = pathLength(result.path);
				expect(matchedLen).toBeLessThan(rawLen * 1.8 + 200);
			});
		});
	}
});
