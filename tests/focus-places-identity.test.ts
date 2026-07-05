/**
 * `matchClusters` — pure-function identity matching that preserves
 * focus_places.id across nightly re-mining.
 *
 * Today's `refresh-focus-places` wipes and re-inserts every cluster,
 * so the auto-increment id churns each run. Downstream consumers
 * (HMM model_states, journey_patterns, anything that wants to
 * reference a focus place by id) need a stable reference. This
 * module computes the mapping from newly-mined clusters to
 * existing-row ids by centroid overlap, with bipartite matching
 * that handles split/merge implicitly.
 *
 * Algorithm: enumerate all (old, new) pairs within MATCH_RADIUS_M
 * of each other, sort by distance (closest first), greedily assign
 * the closest pair as long as neither side is already assigned.
 * Unassigned new clusters get fresh ids; unassigned old clusters
 * are deleted (they no longer correspond to any mined cluster).
 *
 * Properties:
 *   - 1:1 stable place: same id preserved across rebuilds.
 *   - Drift within radius: same id preserved despite centroid moving.
 *   - Drift beyond radius: old id deleted, new id minted.
 *   - Split (1 old → 2 new): old id assigned to closer new, other new gets fresh id.
 *   - Merge (2 old → 1 new): closer old id preserved, farther old deleted.
 *   - Cold start (no old): every new gets fresh id.
 */

import { describe, expect, it } from "vitest";
import { type ExistingPlace, matchClusters, type NewCluster } from "../src/geo/focus-places-identity.js";

function existing(id: number, lat: number, lon: number, firstSeenTs = 1_700_000_000): ExistingPlace {
	return { id, centroidLat: lat, centroidLon: lon, firstSeenTs };
}

function fresh(lat: number, lon: number): NewCluster {
	return { centroidLat: lat, centroidLon: lon };
}

describe("matchClusters", () => {
	it("returns empty result when both sides are empty", () => {
		const result = matchClusters([], []);
		expect(result.matches).toEqual([]);
		expect(result.deletedOldIds).toEqual([]);
	});

	it("mints fresh ids when there are no existing rows (cold start)", () => {
		const result = matchClusters([], [fresh(51.5, -0.1), fresh(51.6, -0.2)]);
		expect(result.matches).toEqual([
			{ newIndex: 0, oldId: null },
			{ newIndex: 1, oldId: null },
		]);
		expect(result.deletedOldIds).toEqual([]);
	});

	it("deletes old rows when no new clusters exist", () => {
		const result = matchClusters([existing(42, 51.5, -0.1), existing(43, 51.6, -0.2)], []);
		expect(result.matches).toEqual([]);
		expect(result.deletedOldIds.sort()).toEqual([42, 43]);
	});

	it("preserves id for an exact-match cluster (no drift)", () => {
		const result = matchClusters([existing(42, 51.5, -0.1)], [fresh(51.5, -0.1)]);
		expect(result.matches).toEqual([{ newIndex: 0, oldId: 42 }]);
		expect(result.deletedOldIds).toEqual([]);
	});

	it("preserves id when centroid drifts within MATCH_RADIUS_M", () => {
		// 51.5 + 0.0005 deg lat ≈ 55m. Within 150m radius → matched.
		const result = matchClusters([existing(42, 51.5, -0.1)], [fresh(51.5005, -0.1)]);
		expect(result.matches).toEqual([{ newIndex: 0, oldId: 42 }]);
		expect(result.deletedOldIds).toEqual([]);
	});

	it("does NOT match when centroid drifts beyond MATCH_RADIUS_M", () => {
		// 51.5 + 0.002 deg lat ≈ 222m. Outside 150m radius → not matched.
		const result = matchClusters([existing(42, 51.5, -0.1)], [fresh(51.502, -0.1)]);
		expect(result.matches).toEqual([{ newIndex: 0, oldId: null }]);
		expect(result.deletedOldIds).toEqual([42]);
	});

	it("matches each side independently when there are multiple separated clusters", () => {
		const oldClusters = [existing(42, 51.5, -0.1), existing(43, 52.5, -0.2)];
		const newClusters = [
			fresh(51.5001, -0.1), // matches 42
			fresh(52.5001, -0.2), // matches 43
		];
		const result = matchClusters(oldClusters, newClusters);
		expect(result.matches).toEqual([
			{ newIndex: 0, oldId: 42 },
			{ newIndex: 1, oldId: 43 },
		]);
		expect(result.deletedOldIds).toEqual([]);
	});

	it("handles a split: one old cluster matches two new clusters — closer new keeps the id", () => {
		// Old at (51.5, -0.1). Two new clusters, one closer than the other.
		// Both within match radius.
		const oldClusters = [existing(42, 51.5, -0.1)];
		const newClusters = [
			fresh(51.501, -0.1), // ~111m from old
			fresh(51.5003, -0.1), // ~33m from old (CLOSER)
		];
		const result = matchClusters(oldClusters, newClusters);
		// Closer new keeps the old id; farther gets fresh.
		expect(result.matches).toEqual([
			{ newIndex: 0, oldId: null },
			{ newIndex: 1, oldId: 42 },
		]);
		expect(result.deletedOldIds).toEqual([]);
	});

	it("handles a merge: two old clusters match one new cluster — closer old preserved, other deleted", () => {
		const oldClusters = [
			existing(42, 51.501, -0.1), // ~111m from new
			existing(43, 51.5003, -0.1), // ~33m from new (CLOSER)
		];
		const newClusters = [fresh(51.5, -0.1)];
		const result = matchClusters(oldClusters, newClusters);
		expect(result.matches).toEqual([{ newIndex: 0, oldId: 43 }]);
		expect(result.deletedOldIds).toEqual([42]);
	});

	it("only considers pairs within MATCH_RADIUS_M (cross-cluster contamination guard)", () => {
		// Old A near new A, old B near new B, but A-B and B-A pairs are
		// outside radius. Greedy should still match A↔A and B↔B even if
		// scanning order is weird.
		const oldClusters = [existing(42, 51.5, -0.1), existing(43, 51.6, -0.2)];
		const newClusters = [
			fresh(51.6001, -0.2), // matches 43
			fresh(51.5001, -0.1), // matches 42
		];
		const result = matchClusters(oldClusters, newClusters);
		// Pair distances (rough): (42,1)=11m, (43,0)=11m, (42,0)=14000m, (43,1)=14000m.
		// Greedy picks the two ~11m pairs.
		expect(result.matches.find((m) => m.newIndex === 0)?.oldId).toBe(43);
		expect(result.matches.find((m) => m.newIndex === 1)?.oldId).toBe(42);
		expect(result.deletedOldIds).toEqual([]);
	});

	it("breaks ties by preferring the older (longer-lived) existing place", () => {
		// Two old clusters equidistant from one new cluster. The older
		// (lower firstSeenTs) wins the match — preserves established
		// identity over recently-created clusters.
		const oldClusters = [
			existing(42, 51.5005, -0.1, 1_750_000_000), // newer
			existing(43, 51.4995, -0.1, 1_700_000_000), // older — should win the tie
		];
		const newClusters = [fresh(51.5, -0.1)];
		const result = matchClusters(oldClusters, newClusters);
		expect(result.matches).toEqual([{ newIndex: 0, oldId: 43 }]);
		expect(result.deletedOldIds).toEqual([42]);
	});
});
