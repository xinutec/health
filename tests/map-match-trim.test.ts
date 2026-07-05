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
});
