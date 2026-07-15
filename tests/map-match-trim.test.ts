import { describe, expect, it } from "vitest";
import { pathLength, trimOverRouteExcursions } from "../src/geo/map-match-core.js";

/**
 * `trimOverRouteExcursions` removes the out-and-back loops the corridor-weighted
 * router invents (#293): a stretch of matched path that travels far while its
 * projection onto the GPS-fix corridor barely advances. Gap-fills (corridor
 * advances with the path) and clean walks (short per-group length) survive.
 *
 * Fixes run E along lon at lat 51.5 (~41.6 m per 0.0006° lon); the loop drops
 * ~111 m S in latitude.
 */
const p = (lat: number, lon: number, ts = 0) => ({ lat, lon, ts });
const A = p(51.5, 0, 0);
const B = p(51.5, 0.0006, 60);
const C = p(51.5, 0.0012, 120);

describe("trimOverRouteExcursions", () => {
	it("leaves a clean match that follows the fixes unchanged", () => {
		const path = [A, B, C];
		expect(trimOverRouteExcursions([A, B, C], path)).toEqual(path);
	});

	it("collapses an out-and-back loop the GPS never took to a direct hop", () => {
		// Between fixes B and C, the matched path loops ~111 m south and back.
		const loop = [A, B, p(51.499, 0.0006, 70), p(51.499, 0.0007, 80), B, C];
		const out = trimOverRouteExcursions([A, B, C], loop);
		// The invented southern loop vertices are gone…
		expect(out.some((v) => v.lat < 51.4999)).toBe(false);
		// …and the drawn line is much shorter than the looping input.
		expect(pathLength(out)).toBeLessThan(pathLength(loop) / 2);
	});

	it("leaves a gap-fill (corridor advances with the path) untouched", () => {
		// A sparse stretch: two fixes ~220 m apart, the matched path bridging them
		// in a few steps that DO advance along the corridor.
		const far = p(51.5, 0.0036, 200); // ~250 m east of A
		const fixes = [A, far];
		const path = [A, p(51.5, 0.0012, 60), p(51.5, 0.0024, 130), far];
		expect(trimOverRouteExcursions(fixes, path)).toEqual(path);
	});

	it("returns the path unchanged when there is too little to trim", () => {
		expect(trimOverRouteExcursions([A, B], [A, B])).toEqual([A, B]);
	});

	// The temporal-stall spur (#362): the router doubles back over street the
	// walker JUST covered, so every spur vertex sits near a fix from the descent
	// — spatially on-corridor — while the corridor position is frozen (the
	// wobbling fixes never re-walk the street).
	describe("temporal stall over just-walked ground", () => {
		// A N→S street along lon 0 into a junction at lat 51.5, then E along the
		// cross street. ~111 m per 0.001° lat; ~69 m per 0.001° lon at this lat.
		const south = [p(51.5008, 0, 0), p(51.50055, 0, 30), p(51.5003, 0, 60), p(51.50005, 0, 90)];
		const wobble = [p(51.50005, 0.00003, 100), p(51.50008, 0.00001, 110), p(51.50004, 0.00005, 120)];
		const east = [p(51.5, 0.0006, 180), p(51.5, 0.0012, 240)];
		const fixes = [...south, ...wobble, ...east];
		const jn = p(51.5, 0, 95);

		it("excises a ~100 m doubling-back the fixes never re-traced", () => {
			// Path: down the street, reach the junction, back up ~50 m, return,
			// continue east. Every spur vertex is within ~17 m of a descent fix.
			const spur = [p(51.50022, 0, 105), p(51.50045, 0, 110), p(51.50022, 0, 115)];
			const path = [...south.map((f) => p(f.lat, 0, f.ts)), jn, ...spur, p(51.5, 0, 125), ...east];
			const out = trimOverRouteExcursions(fixes, path);
			expect(out.some((v) => v.lat > 51.5001 && v.ts > 95)).toBe(false);
			expect(pathLength(out)).toBeLessThan(pathLength(path) - 80);
		});

		it("keeps an out-and-back the GPS actually traced", () => {
			// The fixes themselves walk out ~100 m and back before heading east:
			// corridor arc advances in step with the path, so nothing is excised.
			const traced = [p(51.5, 0, 0), p(51.5009, 0, 60), p(51.5, 0, 120), p(51.5, 0.0006, 180), p(51.5, 0.0012, 240)];
			const path = traced.map((f) => p(f.lat, f.lon, f.ts));
			expect(trimOverRouteExcursions(traced, path)).toEqual(path);
		});

		it("keeps a way-bend the raw GPS cut across (net displacement is real)", () => {
			// Sparse fixes chord ~124 m E; the way detours ~60 m S around a block.
			// The bend ends far from where it started — a reversal test must spare it.
			const sparse = [p(51.5, 0, 0), p(51.5, 0.0018, 240)];
			const bend = [p(51.5, 0, 0), p(51.49946, 0, 60), p(51.49946, 0.0018, 180), p(51.5, 0.0018, 240)];
			expect(trimOverRouteExcursions(sparse, bend)).toEqual(bend);
		});
	});
});
