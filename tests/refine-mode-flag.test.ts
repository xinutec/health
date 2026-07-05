/**
 * Tests that refineMode toggles between the legacy rule cascade
 * and the factor-scorer path via the USE_FACTOR_SCORER env flag.
 *
 * The legacy path is what 64 existing tests in osm.test.ts pin; we
 * don't re-prove that here. We verify:
 *
 *   - With the flag OFF (default), refineMode behaves exactly as
 *     before (a sanity spot-check; the existing test suite is the
 *     real coverage).
 *   - With the flag ON, refineMode uses the candidate generator +
 *     aggregator + (osm-distance + mode-coherence) factors. For
 *     the canonical cases — single motorway, parallel rail+road,
 *     subway-under-arterial — the factor path produces the same
 *     mode + wayName as the cascade.
 *
 * Equivalence isn't perfect across all cases (the factor path has
 * fewer rules and won't reproduce e.g. the aeroway-overwrites-mode
 * dispatch). We pin the cases where it should agree; differences on
 * other cases are noted as Phase 1 follow-up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type NearbyWay, refineMode } from "../src/geo/osm.js";

describe("refineMode flag toggle", () => {
	beforeEach(() => {
		// Default: flag off.
		vi.stubEnv("USE_FACTOR_SCORER", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("flag off → cascade unchanged: single motorway picks driving", () => {
		const r = refineMode("driving", 100, [{ type: "highway", subtype: "motorway", name: "M25", distanceM: 10 }]);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("M25");
	});

	it("flag on → factor path: single motorway picks driving on M25", () => {
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const r = refineMode("driving", 100, [{ type: "highway", subtype: "motorway", name: "M25", distanceM: 10 }]);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("M25");
	});

	it("flag on → factor path: rail closer than parallel road picks train", () => {
		// London tube-under-arterial pattern. The cascade and the
		// factor path should agree on this case.
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "subway", name: "Some Line", distanceM: 20 },
			{ type: "highway", subtype: "primary", name: "Some Road", distanceM: 30 },
		];
		const r = refineMode("driving", 65, ways);
		expect(r.mode).toBe("train");
		expect(r.wayName).toBe("Some Line");
	});

	it("flag on → factor path: road closer than parallel rail picks driving (Betuweroute)", () => {
		// Symmetric case: the cascade's distance-aware Betuweroute fix.
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const ways: NearbyWay[] = [
			{ type: "railway", subtype: "rail", name: "Betuweroute", distanceM: 30 },
			{ type: "highway", subtype: "motorway", name: "A15", distanceM: 10 },
		];
		const r = refineMode("driving", 100, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("A15");
	});

	it("flag on → factor path: driveable secondary preferred over closer footway at driving speed", () => {
		// Cascade's pickBestHighway equivalent. Factor combo:
		// osm-distance (-log(20/10) - -log(27/10) = 0.30 nats for the
		// footway over the secondary) is dominated by mode-coherence
		// (driving on footway -1.5 vs driving on secondary +0.3 = 1.8
		// nat penalty for footway). Net: secondary wins.
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const ways: NearbyWay[] = [
			{ type: "highway", subtype: "footway", distanceM: 20 },
			{ type: "highway", subtype: "secondary", name: "Real Road", distanceM: 27 },
		];
		const r = refineMode("driving", 65, ways);
		expect(r.mode).toBe("driving");
		expect(r.wayName).toBe("Real Road");
	});

	it("flag on → factor path: no ways → falls back to originalMode", () => {
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const r = refineMode("walking", 4, []);
		expect(r.mode).toBe("walking");
		expect(r.wayName).toBeUndefined();
	});

	it("flag on → factor path: confidence and reason are populated", () => {
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const r = refineMode("driving", 100, [{ type: "highway", subtype: "motorway", name: "M25", distanceM: 10 }]);
		expect(["low", "medium", "high"]).toContain(r.confidence);
		expect(r.reason.length).toBeGreaterThan(0);
	});

	it("flag off → factorBreakdown is undefined (cascade path)", () => {
		const r = refineMode("driving", 100, [{ type: "highway", subtype: "motorway", name: "M25", distanceM: 10 }]);
		expect(r.factorBreakdown).toBeUndefined();
	});

	it("flag on → factorBreakdown is populated with best + alternatives + margin", () => {
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const r = refineMode("driving", 65, [
			{ type: "highway", subtype: "secondary", name: "Real Road", distanceM: 27 },
			{ type: "highway", subtype: "footway", distanceM: 20 },
		]);
		expect(r.factorBreakdown).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: just asserted above
		const fb = r.factorBreakdown!;
		expect(fb.best.mode).toBe("driving");
		expect(fb.best.wayName).toBe("Real Road");
		expect(fb.alternatives.length).toBeGreaterThan(0);
		expect(fb.margin).toBeGreaterThan(0);
		expect(fb.best.factors.length).toBeGreaterThan(0);
		expect(fb.best.factors.map((f) => f.name)).toContain("mode-coherence");
		expect(fb.best.factors.map((f) => f.name)).toContain("osm-distance");
	});
});
