/**
 * Honest-gaps scenario tests. The algorithmic targets of
 * `docs/design/probabilistic-principles.md`:
 *
 * - Trajectory-segmented `findStays`: time-ordered proximity
 *   clustering so a day with multiple distinct stops doesn't get
 *   collapsed into one phantom stay at the spatial median.
 *
 * - `unknown` mode emission in `inferTransitGaps`: when a long
 *   no-fix gap implies sub-walking-pace movement, the user was
 *   stationary somewhere we can't observe — emit `unknown`, not
 *   "walking at 0.1 km/h".
 *
 * Synthetic tests isolate the algorithm under test from upstream
 * Kalman / windowing behaviour. A secondary assertion replays the
 * real 2026-04-30 fixture (gitignored) as a regression check on
 * multi-modal clustering.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import { classifySegments, type TrackSegment } from "../../src/geo/segments.js";
import { describeWithFixture } from "../helpers/describe-with-fixture.js";

function fix(ts: number, lat: number, lon: number): FilteredPoint {
	return { ts, lat, lon, speed_kmh: 0, bearing: 0 };
}

describe("honest gaps — synthetic", () => {
	it("emits separate stays for spatially distinct sub-clusters in one time window", () => {
		// Three sub-clusters at distinct lat/lons (~300 m apart),
		// interleaved in time inside one "stay-detector gap" window.
		// Today's `findStays` clusters all six fixes by spatial median +
		// 150 m radius — picking one as the centroid and dropping the
		// other two clusters as outliers. After the trajectory-
		// segmentation rewrite, each spatially distinct cluster becomes
		// its own stay.
		const t0 = 1_700_000_000;
		const points: FilteredPoint[] = [];
		// Cluster A: 2 fixes 20 min apart at (51.840, 5.860).
		points.push(fix(t0, 51.84, 5.86));
		points.push(fix(t0 + 20 * 60, 51.84 + 1e-5, 5.86 + 1e-5));
		// Cluster B: 2 fixes 20 min apart at (51.843, 5.860) — ~330 m north of A.
		points.push(fix(t0 + 90 * 60, 51.843, 5.86));
		points.push(fix(t0 + 110 * 60, 51.843 + 1e-5, 5.86 + 1e-5));
		// Cluster C: 2 fixes 20 min apart at (51.840, 5.864) — ~280 m east of A.
		points.push(fix(t0 + 180 * 60, 51.84, 5.864));
		points.push(fix(t0 + 200 * 60, 51.84 + 1e-5, 5.864 + 1e-5));

		const segments = classifySegments(points);
		const stays = segments.filter((s) => s.mode === "stationary");
		expect(stays.length, "three spatially distinct clusters should each yield a stay").toBeGreaterThanOrEqual(3);
	});

	it("tolerates a lone outlier fix inside an otherwise-stationary cluster", () => {
		// 30 stationary fixes at place A, with one outlier fix dropped
		// in the middle (sudden 500 m jump). The outlier should not
		// fracture the cluster into pieces — a single bad GPS fix is
		// noise, not evidence of movement.
		const t0 = 1_700_000_000;
		const points: FilteredPoint[] = [];
		for (let i = 0; i < 30; i++) {
			points.push(fix(t0 + i * 60, 51.844 + i * 1e-6, 5.857 + i * 1e-6));
		}
		// Inject outlier: 500 m east at minute 15.
		points.splice(15, 0, fix(t0 + 15 * 60 + 30, 51.844, 5.864));
		// Sort by ts to mimic real input.
		points.sort((a, b) => a.ts - b.ts);

		const segments = classifySegments(points);
		const stays = segments.filter((s) => s.mode === "stationary");
		expect(stays.length, "lone outlier should not split the stationary cluster").toBeLessThanOrEqual(1);
	});

	it("emits `unknown` for a sub-walking-pace gap longer than 30 minutes", () => {
		// Two stationary clusters ~330 m apart with a 2-hour signal gap
		// between them. Implied straight-line speed across the gap:
		// 330 m / 7200 s = 0.16 km/h — far below walking pace.
		// Today's `inferTransitGaps` emits "walking" for any gap with
		// speed < 7 km/h; that produces a 2-hour 0.16 km/h walking
		// segment. After the honest-gaps rule, this regime should emit
		// `unknown`.
		const tA = 1_700_000_000;
		const points: FilteredPoint[] = [];
		for (let i = 0; i <= 30; i++) {
			points.push(fix(tA + i * 60, 51.844 + i * 1e-6, 5.857 + i * 1e-6));
		}
		const gapStart = tA + 30 * 60;
		const gapEnd = gapStart + 120 * 60;
		for (let i = 0; i <= 30; i++) {
			points.push(fix(gapEnd + i * 60, 51.847 + i * 1e-6, 5.857 + i * 1e-6));
		}

		const segments = classifySegments(points);

		const slowAndLong = segments.filter(
			(s) =>
				(s.mode === "walking" || s.mode === "cycling" || s.mode === "driving") &&
				s.endTs - s.startTs >= 30 * 60 &&
				s.avgSpeed < 2,
		);
		expect(slowAndLong, "no sub-walking-pace moving segment longer than 30 min").toEqual([]);

		const unknownSpanningGap = segments.filter(
			(s) => s.mode === "unknown" && s.startTs <= gapStart + 5 * 60 && s.endTs >= gapEnd - 5 * 60,
		);
		expect(unknownSpanningGap.length, "an `unknown` segment should span the 2 h signal gap").toBeGreaterThanOrEqual(1);
	});
});

// --- Real-data fixture regression check (gitignored fixture) ---

const FIXTURE_URL = new URL("../fixtures/days/2026-04-30-pippijn.json", import.meta.url);

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

// Central-Nijmegen blob bounds (UTC). The fixture has fixes at
// distinct spatial clusters (Bairro Alto, parents' flat, café, etc.)
// inside this stretch — the trajectory-segmented findStays should
// emit a separate stay per cluster.
const CENTRAL_NIJMEGEN_START = 1_777_545_284;
const CENTRAL_NIJMEGEN_END = 1_777_570_661;

// 18:13 UTC last cluster fix → 20:35 UTC first Vertoef-arrival fix.
// The 2 h 22 m phantom-walking gap sits between these.
const PRE_VERTOEF_GAP_START = 1_777_568_000;
const PRE_VERTOEF_GAP_END = 1_777_582_000;

function overlaps(seg: TrackSegment, start: number, end: number): boolean {
	return seg.endTs > start && seg.startTs < end;
}

describeWithFixture("honest gaps — 2026-04-30 fixture", fixture, (fx) => {
	const filtered: FilteredPoint[] = fx.points.map((p) => ({
		ts: p.ts,
		lat: p.lat,
		lon: p.lon,
		speed_kmh: p.speed_kmh,
		bearing: p.bearing,
	}));

	const segments = classifySegments(filtered);

	it("emits multiple stationary stays inside the central-Nijmegen window", () => {
		const inWindow = segments.filter(
			(s) => s.mode === "stationary" && overlaps(s, CENTRAL_NIJMEGEN_START, CENTRAL_NIJMEGEN_END),
		);
		// Ground-truth narrative lists 4 distinct stops in this window
		// (Bairro Alto, parents', café, dinner). Some of those have
		// only 1 in-window fix and won't pass the ≥ 2-fix threshold,
		// but at minimum the parents'-flat repeats + the café cluster
		// + the Bairro Alto cluster should each surface.
		expect(
			inWindow.length,
			"central-Nijmegen blob should split into ≥ 3 spatially distinct stays",
		).toBeGreaterThanOrEqual(3);
	});

	it("emits at least one `unknown` segment across the 2h22m pre-Vertoef gap", () => {
		const inGap = segments.filter(
			(s) => s.mode === "unknown" && overlaps(s, PRE_VERTOEF_GAP_START, PRE_VERTOEF_GAP_END),
		);
		expect(
			inGap.length,
			"the 2 h 22 m pre-Vertoef signal gap should produce an `unknown` segment",
		).toBeGreaterThanOrEqual(1);
	});
});
