/**
 * Interchange decomposition (task #222).
 *
 * A train segment whose board/alight stations share no common line is
 * physically impossible as one ride (#181's validity constraint). The
 * motivating leg: a journey home rendered as ONE train between two
 * stations on disjoint lines, while the watch recorded the interchange
 * walk mid-gap (walk–pause–walk step burst) and GPS was dark underground.
 *
 * Decomposition evidence:
 *   - the burst times the change;
 *   - the interchange station is a station on BOTH a line serving the
 *     board end and a line serving the alight end;
 *   - among candidates, timing picks: expected arrival ≈ leg start +
 *     boarding wait + distance-derived ride time. (Validated against the
 *     user's confirmed change: the timing fit chose correctly where
 *     resurfacing geometry could not — parallel corridors.)
 *
 * All stations/coordinates here are synthetic, anchored at (50.0, 5.0).
 */

import { describe, expect, it } from "vitest";
import type { StepPoint } from "../src/geo/biometrics.js";
import { findInterchangeBurst, pickInterchange } from "../src/geo/interchange-split.js";

const T0 = 1_750_000_000;

function steps(fromMin: number, toMin: number, perMin: number): StepPoint[] {
	const out: StepPoint[] = [];
	for (let m = fromMin; m < toMin; m++) if (perMin > 0) out.push({ ts: T0 + m * 60, steps: perMin });
	return out;
}

/** A synthetic station `km` east of the anchor. */
function station(name: string, km: number) {
	return { name, lat: 50.0, lon: 5.0 + (km * 1000) / (111_320 * Math.cos((50 * Math.PI) / 180)) };
}

describe("findInterchangeBurst", () => {
	it("finds a walk–pause–walk burst mid-leg (the measured shape)", () => {
		// 35-min leg; burst at minutes 12-16: 18, 112, 4, 113, 18.
		const s: StepPoint[] = [
			{ ts: T0 + 12 * 60, steps: 18 },
			{ ts: T0 + 13 * 60, steps: 112 },
			{ ts: T0 + 14 * 60, steps: 4 },
			{ ts: T0 + 15 * 60, steps: 113 },
			{ ts: T0 + 16 * 60, steps: 18 },
		];
		const burst = findInterchangeBurst(s, T0, T0 + 35 * 60);
		expect(burst).not.toBeNull();
		expect(burst?.startTs).toBeGreaterThanOrEqual(T0 + 12 * 60);
		expect(burst?.endTs).toBeLessThanOrEqual(T0 + 17 * 60);
	});

	it("ignores walking at the leg edges (boarding/alighting walks)", () => {
		const s = [...steps(0, 3, 100), ...steps(32, 35, 100)];
		expect(findInterchangeBurst(s, T0, T0 + 35 * 60)).toBeNull();
	});

	it("returns null when there is no burst (direct train)", () => {
		expect(findInterchangeBurst(steps(0, 35, 0), T0, T0 + 35 * 60)).toBeNull();
	});

	it("returns null when two separate bursts make the change ambiguous", () => {
		const s: StepPoint[] = [...steps(8, 10, 110), ...steps(22, 24, 110)];
		expect(findInterchangeBurst(s, T0, T0 + 35 * 60)).toBeNull();
	});
});

describe("pickInterchange", () => {
	// Synthetic geometry along one straight street: board at 0 km.
	// Line A (serves board): stations at 0, 1, 3.2, 5 km.
	// Line B (serves alight at 12 km): stations at 1, 3.2, 7, 12 km.
	// Shared candidates: "Near" (1 km) and "Far" (3.2 km).
	const lineA = [station("Board", 0), station("Near", 1), station("Far", 3.2), station("EndA", 5)];
	const lineB = [station("Near", 1), station("Far", 3.2), station("MidB", 7), station("Alight", 12)];
	const base = {
		boardLat: 50.0,
		boardLon: 5.0,
		alightLat: station("Alight", 12).lat,
		alightLon: station("Alight", 12).lon,
		legStartTs: T0,
		linesA: ["Line A"],
		linesB: ["Line B"],
		stationsByLine: new Map([
			["Line A", lineA],
			["Line B", lineB],
		]),
	};

	it("picks the candidate whose distance-derived timing matches the burst", () => {
		// Burst ~10.5 min in: wait (3 min) + 3.2 km ride (~6.4 min) fits
		// "Far"; "Near" would predict ~5 min. (The real-world validation:
		// the farther interchange won against the closer canonical one.)
		const picked = pickInterchange({ ...base, burstStartTs: T0 + 10.5 * 60 });
		expect(picked?.station).toBe("Far");
		expect(picked?.lineA).toBe("Line A");
		expect(picked?.lineB).toBe("Line B");
	});

	it("picks the near candidate for an early burst", () => {
		const picked = pickInterchange({ ...base, burstStartTs: T0 + 5 * 60 });
		expect(picked?.station).toBe("Near");
	});

	it("returns null when no station serves both lines", () => {
		const picked = pickInterchange({
			...base,
			stationsByLine: new Map([
				["Line A", [station("Board", 0), station("OnlyA", 2)]],
				["Line B", [station("OnlyB", 6), station("Alight", 12)]],
			]),
			burstStartTs: T0 + 10 * 60,
		});
		expect(picked).toBeNull();
	});

	it("returns null when even the best timing fit is wildly off", () => {
		// Burst at +30 min, but every candidate predicts ≤ ~10 min.
		const picked = pickInterchange({ ...base, burstStartTs: T0 + 30 * 60 });
		expect(picked).toBeNull();
	});

	it("never proposes the board or alight station itself as the change", () => {
		// "Board" appears on both lines here — a same-station change is
		// not a decomposition.
		const both = new Map([
			["Line A", [station("Board", 0), station("Far", 3.2)]],
			["Line B", [station("Board", 0), station("Far", 3.2), station("Alight", 12)]],
		]);
		const picked = pickInterchange({ ...base, stationsByLine: both, burstStartTs: T0 + 7 * 60 });
		expect(picked?.station).toBe("Far");
	});
});

describe("pickInterchange direction constraint", () => {
	it("rejects a backtracking candidate even with perfect timing", () => {
		// "Behind" sits 3 km the WRONG way from the board point; its
		// distance-derived timing matches the burst exactly, but nobody
		// rides away from the destination to change.
		const lineA = [station("Board", 0), station("Behind", -3), station("Fwd", 3)];
		const lineB = [station("Behind", -3), station("Fwd", 3), station("Alight", 12)];
		const picked = pickInterchange({
			boardLat: 50.0,
			boardLon: 5.0,
			alightLat: station("Alight", 12).lat,
			alightLon: station("Alight", 12).lon,
			legStartTs: T0,
			// 3 km → wait 3min + ~5.5min ride = +8.5min: fits BOTH candidates' distance.
			burstStartTs: T0 + 8.5 * 60,
			linesA: ["Line A"],
			linesB: ["Line B"],
			stationsByLine: new Map([
				["Line A", lineA],
				["Line B", lineB],
			]),
		});
		expect(picked?.station).toBe("Fwd");
	});
});
