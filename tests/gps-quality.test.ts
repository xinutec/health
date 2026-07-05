/**
 * GPS quality-control pre-filter.
 *
 * Underground (tube, deep buildings) the phone falls back to cell-tower
 * triangulation and emits positions that are *wrong*, not just noisy —
 * teleporting kilometres and back. No smoothing filter recovers a true
 * trajectory from that. The principled answer is to discard the
 * incoherent run entirely and let the downstream gap-inference treat
 * it as missing data.
 *
 * `qualityFilterGps` walks the raw fixes with an "anchor" (the last
 * kept fix). A fix reachable from the anchor at a plausible speed is
 * kept and becomes the new anchor. A fix that is NOT reachable starts
 * a suspected garbage run: we scan forward for the first later fix
 * that IS reachable from the anchor (the surfacing point) and drop
 * everything between. If no such bridge exists within the window the
 * run is genuine sustained fast travel (plane, high-speed rail) — those
 * fixes are kept.
 *
 * All test coordinates are synthetic, anchored at (50.0, 5.0).
 */

import { describe, expect, it } from "vitest";
import { qualityFilterGps } from "../src/geo/gps-quality.js";
import type { GpsPoint } from "../src/geo/kalman.js";

const LAT_DEG_PER_M = 1 / 111_000;
const LON_DEG_PER_M = 1 / (111_000 * Math.cos((50 * Math.PI) / 180));

/** A fix `metresEast`/`metresNorth` from the synthetic anchor (50.0, 5.0). */
function fix(ts: number, metresNorth: number, metresEast: number, accuracy = 20): GpsPoint {
	return {
		ts,
		lat: 50.0 + metresNorth * LAT_DEG_PER_M,
		lon: 5.0 + metresEast * LON_DEG_PER_M,
		accuracy,
	};
}

describe("qualityFilterGps", () => {
	it("passes a clean walking track through unchanged", () => {
		// 12 fixes, ~5 km/h east, 15 s apart (~21 m per step). All coherent.
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 12; i++) fixes.push(fix(1000 + i * 15, 0, i * 21));
		const result = qualityFilterGps(fixes);
		expect(result).toHaveLength(12);
		expect(result).toEqual(fixes);
	});

	it("drops a single GPS teleport spike", () => {
		// 6 clean fixes, one fix teleporting 2.5 km off, 6 clean fixes.
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 6; i++) fixes.push(fix(1000 + i * 15, 0, i * 21));
		const spikeTs = 1000 + 6 * 15;
		fixes.push(fix(spikeTs, 2500, 2500)); // teleport
		for (let i = 0; i < 6; i++) fixes.push(fix(1000 + 7 * 15 + i * 15, 0, (6 + i) * 21));
		const result = qualityFilterGps(fixes);
		expect(result).toHaveLength(12);
		expect(result.some((p) => p.ts === spikeTs)).toBe(false);
	});

	it("drops a multi-fix underground garbage run, leaving an internally coherent track", () => {
		// Stationary at station A (8 fixes), then a run of thrashing garbage
		// fixes while underground (each one kilometres off, incoherent with
		// its neighbours), then the user surfaces at station B (~3 km away,
		// ~8 min later) and walks (8 fixes).
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 8; i++) fixes.push(fix(1000 + i * 15, 0, 0)); // station A
		const tunnelStart = 1000 + 8 * 15;
		// Garbage: each fix thrashes kilometres around, incoherently.
		const garbageOffsets = [
			[2600, -900],
			[-1800, 2400],
			[3100, 1200],
			[-2200, -1500],
			[900, 3000],
			[-2800, 600],
		];
		garbageOffsets.forEach(([n, e], k) => {
			fixes.push(fix(tunnelStart + k * 40, n, e));
		});
		const surfaceTs = tunnelStart + 8 * 60;
		for (let i = 0; i < 8; i++) fixes.push(fix(surfaceTs + i * 15, 0, 3000 + i * 21));
		const result = qualityFilterGps(fixes);

		// Invariant: the surviving stream is internally coherent — no
		// consecutive kept pair implies a physically impossible speed.
		// That's the real contract: the Kalman filter downstream only
		// ever sees a track it can smooth.
		for (let k = 1; k < result.length; k++) {
			const a = result[k - 1];
			const b = result[k];
			const dLatM = (b.lat - a.lat) * 111_320;
			const dLonM = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
			const speed = (Math.sqrt(dLatM ** 2 + dLonM ** 2) / (b.ts - a.ts)) * 3.6;
			expect(speed, `kept pair ${a.ts}->${b.ts} implies ${speed.toFixed(0)} km/h`).toBeLessThanOrEqual(160);
		}
		// Every clean station fix survives — QC only drops garbage.
		for (let i = 0; i < 8; i++) {
			expect(
				result.some((p) => p.ts === 1000 + i * 15),
				`station A fix ${i} dropped`,
			).toBe(true);
			expect(
				result.some((p) => p.ts === surfaceTs + i * 15),
				`station B fix ${i} dropped`,
			).toBe(true);
		}
		// The bulk of the garbage run is gone (the wildly-thrashing fixes
		// that imply hundreds of km/h between neighbours).
		expect(result.length).toBeLessThan(20);
	});

	it("drops a poor-accuracy underground run that marches forward UNDER the speed ceiling", () => {
		// The 2026-06-28 return-tube signature: not thrashing garbage, but
		// cell-tower fixes that march roughly forward at tube speed — each hop
		// is speed-coherent (well under the 150 km/h ceiling, so the speed test
		// alone keeps them) yet every fix has terrible accuracy (≈150 m,
		// cell-tower). Underground the position is wrong, not just noisy, so the
		// run must be dropped and left as a gap for reconstruction. Bracketed by
		// a clean (good-accuracy) station stay and a clean surfacing walk.
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 8; i++) fixes.push(fix(1000 + i * 15, 0, 0, 8)); // station A, good acc
		const tunnelStart = 1000 + 8 * 15;
		// 6 poor-accuracy fixes, +400 m east every 20 s = 72 km/h (< 150), acc 150.
		for (let k = 0; k < 6; k++) fixes.push(fix(tunnelStart + k * 20, 0, 400 + k * 400, 150));
		const surfaceTs = tunnelStart + 6 * 20 + 60;
		for (let i = 0; i < 8; i++) fixes.push(fix(surfaceTs + i * 15, 0, 3200 + i * 21, 12)); // station B walk, good acc
		const result = qualityFilterGps(fixes);

		// None of the acc-150 cell-tower fixes survive.
		for (let k = 0; k < 6; k++) {
			expect(
				result.some((p) => p.ts === tunnelStart + k * 20),
				`poor-accuracy fix ${k} kept`,
			).toBe(false);
		}
		// Every clean (good-accuracy) bracket fix survives.
		for (let i = 0; i < 8; i++) {
			expect(
				result.some((p) => p.ts === 1000 + i * 15),
				`station A fix ${i} dropped`,
			).toBe(true);
			expect(
				result.some((p) => p.ts === surfaceTs + i * 15),
				`station B fix ${i} dropped`,
			).toBe(true);
		}
	});

	it("keeps a poor-accuracy stay that is NOT moving (indoor GPS, not a tube ride)", () => {
		// Guard against over-dropping: a stationary indoor sit also has poor
		// accuracy, but ≈0 speed. It must NOT be dropped — only inaccurate
		// *movement* is the underground signature.
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 4; i++) fixes.push(fix(1000 + i * 15, 0, 0, 10)); // good entry
		// 8 poor-accuracy fixes jittering within ~30 m, near-stationary.
		const sitStart = 1000 + 4 * 15;
		const jitter = [5, -8, 12, -3, 9, -11, 4, -6];
		jitter.forEach((e, k) => {
			fixes.push(fix(sitStart + k * 30, e, -e, 120));
		});
		const result = qualityFilterGps(fixes);
		// The near-stationary poor-accuracy sit is kept (Kalman down-weights it).
		expect(result.length).toBe(fixes.length);
	});

	it("keeps a poor-accuracy run that jitters FAST but never travels (indoor stay / interchange)", () => {
		// The 2026-06-24 UCLH / 2026-06-12 Elmford-interchange regression
		// guard. A poor-accuracy indoor stay (or a platform-to-platform walk) can
		// jitter ±150 m between cell-tower fixes — each hop implies >15 km/h, so
		// the per-hop test would call it the underground signature — yet the run
		// never goes anywhere: it surfaces back at its anchor. Net displacement,
		// not per-hop speed, separates it from a tube ride, so it must be KEPT.
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 4; i++) fixes.push(fix(1000 + i * 15, 0, 0, 10)); // good entry
		const sitStart = 1000 + 4 * 15;
		// 8 poor-accuracy fixes oscillating ±150 m (each hop ~36 km/h), net ≈ 0.
		const osc = [150, -150, 150, -150, 150, -150, 150, -150];
		osc.forEach((n, k) => {
			fixes.push(fix(sitStart + k * 15, n, 0, 150));
		});
		const exitStart = sitStart + 8 * 15;
		for (let i = 0; i < 4; i++) fixes.push(fix(exitStart + i * 15, 0, 0, 10)); // good exit, same spot
		const result = qualityFilterGps(fixes);
		// Nothing dropped — the run jitters but does not travel, so it is a stay.
		expect(result.length).toBe(fixes.length);
	});

	it("keeps sustained fast travel (a plane), which has no coherent bridge", () => {
		// A plane: 14 fixes marching coherently NE at ~800 km/h, 30 s apart
		// (~6.67 km per step). Every fix is "unreachable" from the previous
		// by the plausible-speed test, but there is no bridge fix reachable
		// from the pre-flight anchor — so the run is genuine fast travel and
		// must be kept.
		const fixes: GpsPoint[] = [];
		// 4 slow pre-flight fixes
		for (let i = 0; i < 4; i++) fixes.push(fix(1000 + i * 30, 0, i * 40));
		// 14 cruise fixes
		const cruiseStart = 1000 + 4 * 30;
		for (let i = 0; i < 14; i++) fixes.push(fix(cruiseStart + i * 30, i * 6670, i * 6670));
		const result = qualityFilterGps(fixes);
		// Nothing dropped — a coherent fast run is real travel.
		expect(result).toHaveLength(18);
	});

	it("returns short inputs unchanged", () => {
		const two = [fix(1000, 0, 0), fix(1015, 0, 21)];
		expect(qualityFilterGps(two)).toEqual(two);
		expect(qualityFilterGps([])).toEqual([]);
	});
});
