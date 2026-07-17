import { describe, expect, it } from "vitest";
import { pointDistToPolyline, spliceMatchedWithDivergentRuns } from "../src/geo/map-match-core.js";

// Geometry helpers: ~111,320 m per degree of latitude; at lat 51.5 one degree
// of longitude is ~69,300 m. The scenarios mirror the 2026-07-15 morning leg:
// a walk the matcher places perfectly on the road, except for a contiguous
// fix run that genuinely leaves the mapped network (a station forecourt).

/** Fixes every ~69 m along lat 51.5 from lon 0, n of them, 30 s apart. */
function onRoadFixes(n: number, lat = 51.5): Array<{ lat: number; lon: number; ts: number }> {
	return Array.from({ length: n }, (_, i) => ({ lat, lon: i * 0.001, ts: 1000 + i * 30 }));
}

/** The matched path: the same straight road, one vertex per fix. */
function roadPath(n: number, lat = 51.5): Array<{ lat: number; lon: number; ts: number }> {
	return onRoadFixes(n, lat);
}

const MAX_STRAY_M = 40;
/** ~0.0009° of latitude ≈ 100 m — well past the 40 m stray bound. */
const OFF_LAT = 51.5009;

describe("spliceMatchedWithDivergentRuns", () => {
	it("returns null when every fix supports the matched path (nothing to splice)", () => {
		const fixes = onRoadFixes(10);
		expect(spliceMatchedWithDivergentRuns(fixes, roadPath(10), MAX_STRAY_M)).toBeNull();
	});

	it("returns null on a systematic parallel-way snap (most fixes divergent)", () => {
		// All fixes ~100 m north of the matched road: the parallel-street error
		// the stray gate exists for. The splice must refuse, not stitch raw
		// everywhere.
		const fixes = onRoadFixes(10, OFF_LAT);
		expect(spliceMatchedWithDivergentRuns(fixes, roadPath(10), MAX_STRAY_M)).toBeNull();
	});

	it("keeps the matched line for the supported span and raw fixes for a divergent tail", () => {
		// 8 fixes on the road, then 4 veering ~100 m off it into a forecourt
		// beside where the mapped network ends (each stays within the ~150 m
		// near-network bound of the path's end).
		const tailLons = [0.007, 0.0075, 0.008, 0.0085];
		const fixes = [...onRoadFixes(8), ...tailLons.map((lon, i) => ({ lat: OFF_LAT, lon, ts: 1000 + (8 + i) * 30 }))];
		const path = roadPath(8); // matcher only covers the on-road span here
		const out = spliceMatchedWithDivergentRuns(fixes, path, MAX_STRAY_M);
		expect(out).not.toBeNull();
		if (out === null) return;
		// The supported span draws on the matched line…
		for (const p of out.slice(0, 4)) {
			expect(pointDistToPolyline(p, path)).toBeLessThan(5);
		}
		// …and the divergent tail draws the raw fixes verbatim (honest raw).
		const tail = out.slice(-4);
		for (let i = 0; i < 4; i++) {
			expect(tail[i].lat).toBeCloseTo(OFF_LAT, 6);
			expect(tail[i].lon).toBeCloseTo(tailLons[i], 6);
		}
		// Vertices stay in time order across the join.
		for (let i = 1; i < out.length; i++) {
			expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
		}
	});

	it("splices a mid-leg divergent run and returns to the matched line after it", () => {
		// On-road, then a 4-fix off-road excursion (unmapped cut-through), then
		// back on-road.
		const fixes = [
			...onRoadFixes(5),
			...Array.from({ length: 4 }, (_, i) => ({ lat: OFF_LAT, lon: (5 + i) * 0.001, ts: 1000 + (5 + i) * 30 })),
			...Array.from({ length: 5 }, (_, i) => ({ lat: 51.5, lon: (9 + i) * 0.001, ts: 1000 + (9 + i) * 30 })),
		];
		const path = roadPath(14);
		const out = spliceMatchedWithDivergentRuns(fixes, path, MAX_STRAY_M);
		expect(out).not.toBeNull();
		if (out === null) return;
		// The excursion's raw fixes appear verbatim…
		const offVerts = out.filter((p) => Math.abs(p.lat - OFF_LAT) < 1e-6);
		expect(offVerts.length).toBe(4);
		// …and both bracketing spans draw on the matched line.
		const first = out[0];
		const last = out[out.length - 1];
		expect(pointDistToPolyline(first, path)).toBeLessThan(5);
		expect(pointDistToPolyline(last, path)).toBeLessThan(5);
		for (let i = 1; i < out.length; i++) {
			expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
		}
	});

	it("returns null when there are too few fixes to judge", () => {
		expect(spliceMatchedWithDivergentRuns(onRoadFixes(2), roadPath(2), MAX_STRAY_M)).toBeNull();
	});

	it("returns null when a divergent fix is a teleport, not a nearby unmapped area", () => {
		// 8 fixes on the road, then a 3-fix run ~2 km away — the 2026-05-15
		// 20:18Z indoor-jitter smear, which must NOT be stitched as if it were
		// a forecourt beside the street.
		const fixes = [
			...onRoadFixes(8),
			...Array.from({ length: 3 }, (_, i) => ({ lat: 51.518, lon: (8 + i) * 0.001, ts: 1000 + (8 + i) * 30 })),
		];
		expect(spliceMatchedWithDivergentRuns(fixes, roadPath(8), MAX_STRAY_M)).toBeNull();
	});

	it("returns null when divergence fragments into many runs (jitter, not a coherent excursion)", () => {
		// Alternating on/off the road every other fix: three separate divergent
		// runs. That is GPS jitter straddling the stray bound, not one unmapped
		// area — splicing would draw a zigzag.
		const fixes = onRoadFixes(12).map((f, i) => ([2, 3, 6, 7, 10, 11].includes(i) ? { ...f, lat: OFF_LAT } : f));
		expect(spliceMatchedWithDivergentRuns(fixes, roadPath(12), MAX_STRAY_M)).toBeNull();
	});

	it("returns null when the splice would inflate the drawn length well past the raw line", () => {
		// Four on-road fixes bracketing a fix-free span, then a divergent tail.
		// The matched path detours ~330 m north inside the fix-free span, so the
		// supported arc slice is far longer than the line the GPS supports —
		// the splice must refuse rather than draw the over-route.
		const fixes = [
			{ lat: 51.5, lon: 0, ts: 1000 },
			{ lat: 51.5, lon: 0.001, ts: 1030 },
			{ lat: 51.5, lon: 0.004, ts: 1120 },
			{ lat: 51.5, lon: 0.005, ts: 1150 },
			{ lat: OFF_LAT, lon: 0.006, ts: 1180 },
			{ lat: OFF_LAT, lon: 0.007, ts: 1210 },
		];
		const detour = [
			{ lat: 51.5, lon: 0, ts: 1000 },
			{ lat: 51.5, lon: 0.001, ts: 1030 },
			{ lat: 51.503, lon: 0.002, ts: 1060 }, // ~330 m out…
			{ lat: 51.503, lon: 0.003, ts: 1090 },
			{ lat: 51.5, lon: 0.004, ts: 1120 }, // …and back
			{ lat: 51.5, lon: 0.005, ts: 1150 },
		];
		expect(spliceMatchedWithDivergentRuns(fixes, detour, MAX_STRAY_M)).toBeNull();
	});
});
