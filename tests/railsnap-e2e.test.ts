/**
 * Rail-snap end-to-end test — runs the station-anchored algorithm on a
 * real captured day.
 *
 * # Why this test is shaped like this
 *
 * The first rail-snap attempt shipped and was reverted three times with
 * every unit test green throughout. Those tests ran on synthetic routes
 * with fixes spread evenly along them; they never exercised the GPS
 * pathologies that actually broke production (platform dwell-clumps,
 * fixes that claim good accuracy but sit a kilometre off, coarse
 * cell-tower scatter). "Tests pass" carried no signal.
 *
 * This test runs the algorithm against a *real captured day*
 * (`capture-railsnap-fixture.ts` output): real GPS fixes, real
 * classified segments, real OSM rail geometry. It asserts outcome
 * *properties* a synthetic test structurally could not — most
 * importantly that the snapped path is not a degenerate blob (the
 * exact failure mode of the reverted attempt).
 *
 * The fixture lives in `tests/fixtures/railsnap/` and is gitignored
 * (real coordinates / journeys, local only — same policy as
 * `tests/fixtures/days/` and `tests/golden/`). When the fixture is
 * absent — i.e. on CI — the whole suite is skipped. Locally it runs on
 * every `npm test` and is the verdict on whether the feature works.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type RailGeometry, type SnapResult, snapTrainSegment } from "../src/geo/rail-snap.js";
import { describeWithFixture } from "./helpers/describe-with-fixture.js";

const FIXTURE_URL = new URL("./fixtures/railsnap/2026-05-17-pippijn.json", import.meta.url);

interface Fixture {
	schema: string;
	segments: Array<{ startTs: number; endTs: number; mode: string; refinedMode: string | null; wayName: string | null }>;
	rawFixes: Array<{ ts: number; lat: number; lon: number }>;
	osmLines: RailGeometry["lines"];
	osmWayRoutes: RailGeometry["wayRoutes"];
	osmStations: RailGeometry["stations"];
}

function loadFixture(): Fixture | null {
	try {
		return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;
	} catch {
		return null;
	}
}

/** Equirectangular metres — good enough at city scale. */
function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

function pathLengthM(pts: Array<{ lat: number; lon: number }>): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += distM(pts[i - 1], pts[i]);
	return total;
}

const fixture = loadFixture();

describeWithFixture("rail-snap E2E — real captured day", fixture, (fx) => {
	const geo: RailGeometry = { lines: fx.osmLines, wayRoutes: fx.osmWayRoutes, stations: fx.osmStations };
	const trainSegs = fx.segments.filter((s) => (s.refinedMode ?? s.mode) === "train" && s.wayName);

	// All rail-line vertices, flattened — used to assert snapped points
	// actually sit on the rail network.
	const railVertices: Array<{ lat: number; lon: number }> = [];
	for (const l of fx.osmLines) {
		for (const [lat, lon] of l.coords) railVertices.push({ lat, lon });
	}

	it("the fixture contains train segments to snap", () => {
		expect(fx.schema).toBe("railsnap-fixture/1");
		expect(trainSegs.length).toBeGreaterThan(0);
	});

	for (const seg of trainSegs) {
		const wayName = seg.wayName;
		if (wayName === null) continue;
		// Label comes from gitignored fixture data at runtime — the
		// committed source carries no real place names.
		describe(`train segment: ${wayName}`, () => {
			// The historic corridor: this run's own GPS fixes. The
			// snapper weights its path to follow them.
			const corridorFixes = fx.rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
			const result = snapTrainSegment({ startTs: seg.startTs, endTs: seg.endTs, wayName }, geo, corridorFixes);

			/** Fail loudly if the segment did not snap — every other
			 *  assertion here is meaningless without a path. */
			const snapped = (): SnapResult => {
				if (result === null) throw new Error(`snapTrainSegment returned null for "${wayName}"`);
				return result;
			};

			it("produces a snapped path", () => {
				expect(result).not.toBeNull();
				expect(snapped().path.length).toBeGreaterThanOrEqual(2);
			});

			it("is not a degenerate blob — the path spans the journey", () => {
				// The reverted attempt collapsed the path to a ~40 m blob at
				// one station. A real ride between two distinct stations
				// covers at least hundreds of metres.
				const r = snapped();
				const endSpan = distM(r.path[0], r.path[r.path.length - 1]);
				expect(endSpan).toBeGreaterThan(300);
				expect(endSpan).toBeGreaterThan(0.55 * distM(r.board, r.alight));
			});

			it("starts near the boarding station and ends near the alighting station", () => {
				const r = snapped();
				expect(distM(r.path[0], r.board)).toBeLessThan(250);
				expect(distM(r.path[r.path.length - 1], r.alight)).toBeLessThan(250);
			});

			it("has monotonic timestamps spanning the segment window", () => {
				const p = snapped().path;
				expect(p[0].ts).toBe(seg.startTs);
				expect(p[p.length - 1].ts).toBe(seg.endTs);
				for (let i = 1; i < p.length; i++) {
					expect(p[i].ts).toBeGreaterThanOrEqual(p[i - 1].ts);
				}
			});

			it("every snapped vertex lies on the rail network", () => {
				// By construction the path is assembled from rail-line
				// geometry; this guards a regression where interpolation
				// drifts the path off-track.
				for (const pt of snapped().path) {
					let nearest = Number.POSITIVE_INFINITY;
					for (const v of railVertices) {
						const d = distM(pt, v);
						if (d < nearest) nearest = d;
						if (nearest < 1) break;
					}
					expect(nearest).toBeLessThan(30);
				}
			});

			it("does not wander — path length is a sane multiple of the station crow-flies", () => {
				const r = snapped();
				expect(pathLengthM(r.path)).toBeLessThan(3 * distM(r.board, r.alight));
			});

			it("follows the historic corridor — the path hugs the real journey's fixes", () => {
				// Route fidelity: the snapped path should trace the line
				// actually ridden, not a geometrically-shorter cut across a
				// line the user never takes. Every vertex bar the station
				// endpoints should sit within reach of a corridor fix.
				const p = snapped().path;
				const interior = p.slice(1, -1);
				const offCorridor = interior.filter((pt) => {
					let nearest = Number.POSITIVE_INFINITY;
					for (const f of corridorFixes) {
						const d = distM(pt, f);
						if (d < nearest) nearest = d;
					}
					return nearest > 500;
				});
				// Allow a little slack for sparse-fix stretches (underground).
				expect(offCorridor.length).toBeLessThan(0.2 * interior.length);
			});
		});
	}
});
