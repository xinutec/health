/**
 * `dropGpsOutliers` — robust GPS-cluster filter for HMM input.
 *
 * Tests pin:
 *   - Tight cluster of fixes around one location is preserved unchanged.
 *   - An isolated 5km-away fix in the middle of a tight cluster is dropped.
 *   - Sustained gradual motion (real travel) is preserved.
 *   - Empty / tiny input returned unchanged.
 *   - First/last fixes of a long stay are evaluated against the
 *     centred-window cluster, not just the past.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { dropGpsOutliers } from "../src/hmm/gps-outliers.js";

function fix(ts: number, lat: number, lon: number): FilteredPoint {
	return { ts, lat, lon, speed_kmh: 0, bearing: 0 };
}

describe("dropGpsOutliers", () => {
	it("preserves a tight cluster around one location", () => {
		const points: FilteredPoint[] = [];
		for (let i = 0; i < 20; i++) points.push(fix(1_700_000_000 + i * 60, 51.5 + i * 0.00001, -0.1));
		const filtered = dropGpsOutliers(points);
		expect(filtered).toHaveLength(20);
	});

	it("drops an isolated rogue fix far from the cluster", () => {
		const points: FilteredPoint[] = [];
		// 10 fixes at Ashvale.
		for (let i = 0; i < 10; i++) points.push(fix(1_700_000_000 + i * 60, 51.57, -0.28));
		// 1 rogue fix at Karlsruhe (~600km away).
		points.push(fix(1_700_000_000 + 10 * 60, 49.0, 8.4));
		// 10 more fixes at Ashvale.
		for (let i = 11; i < 21; i++) points.push(fix(1_700_000_000 + i * 60, 51.57, -0.28));
		const filtered = dropGpsOutliers(points);
		expect(filtered).toHaveLength(20); // 21 - 1 rogue
		for (const p of filtered) {
			expect(p.lat).toBeCloseTo(51.57, 1);
		}
	});

	it("preserves real sustained motion — cluster median drags with the user", () => {
		// Walk: 30 fixes moving north at ~5 km/h. Each minute: ~83m N.
		// Cluster median moves with the user, so no fix is an outlier.
		const points: FilteredPoint[] = [];
		for (let i = 0; i < 30; i++) {
			const lat = 51.5 + i * 0.00075; // ~83m per fix
			points.push(fix(1_700_000_000 + i * 60, lat, -0.1));
		}
		const filtered = dropGpsOutliers(points);
		expect(filtered.length).toBeGreaterThanOrEqual(28); // allow tiny edge tolerance
	});

	it("returns input unchanged when there are fewer than MIN_CLUSTER_SIZE fixes", () => {
		const points = [fix(1, 51.5, -0.1), fix(2, 51.6, -0.1)];
		const filtered = dropGpsOutliers(points);
		expect(filtered).toHaveLength(2);
	});

	it("does not drop the first fix of a long stay (centred window)", () => {
		// 30 fixes at the same location.
		const points: FilteredPoint[] = [];
		for (let i = 0; i < 30; i++) points.push(fix(1_700_000_000 + i * 60, 51.57, -0.28));
		const filtered = dropGpsOutliers(points);
		// All 30 should survive; first fix evaluated against the
		// forward window (other 29 are at the same location).
		expect(filtered).toHaveLength(30);
	});

	it("returns empty for empty input", () => {
		expect(dropGpsOutliers([])).toEqual([]);
	});

	it("drops multiple isolated rogue fixes scattered around a tight stay", () => {
		const points: FilteredPoint[] = [];
		for (let i = 0; i < 30; i++) {
			points.push(fix(1_700_000_000 + i * 60, 51.57, -0.28));
		}
		// Insert 3 rogue fixes at different distant locations.
		points.splice(5, 0, fix(1_700_000_000 + 5 * 60 + 5, 47.4, 8.5)); // Zurich
		points.splice(15, 0, fix(1_700_000_000 + 15 * 60 + 5, 49.0, 8.4)); // Karlsruhe
		points.splice(25, 0, fix(1_700_000_000 + 25 * 60 + 5, 43.7, -79.6)); // Toronto
		const filtered = dropGpsOutliers(points);
		expect(filtered).toHaveLength(30); // 33 - 3 rogue
		for (const p of filtered) {
			expect(Math.abs(p.lat - 51.57)).toBeLessThan(0.1);
		}
	});
});
