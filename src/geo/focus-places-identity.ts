/**
 * `matchClusters` — pure-function identity matching that preserves
 * focus_places.id across nightly re-mining.
 *
 * Today's `refresh-focus-places` wipes and re-inserts every cluster,
 * so the auto-increment id churns each run. Downstream consumers that
 * want to reference a focus place by id (planned: HMM model_states,
 * journey_patterns) need a stable reference. This module computes the
 * mapping from newly-mined clusters to existing-row ids by centroid
 * overlap, with bipartite matching that handles cluster split / merge
 * implicitly.
 *
 * Algorithm:
 *   1. Enumerate all (old, new) pairs whose centroids are within
 *      `MATCH_RADIUS_M`.
 *   2. Sort pairs by distance (closest first), with `firstSeenTs`
 *      ascending as tiebreaker (prefer older existing place when two
 *      pairs are equidistant).
 *   3. Greedily assign: walk the sorted pair list and accept each pair
 *      iff neither side is already assigned.
 *   4. New clusters not assigned any old id → fresh inserts.
 *   5. Old ids not assigned to any new cluster → deletions.
 *
 * Greedy bipartite matching is enough for the typical 5-30 cluster
 * scale per user. For larger spaces, swap in Hungarian; the interface
 * (input pairs → MatchResult) stays the same.
 */

export interface ExistingPlace {
	id: number;
	centroidLat: number;
	centroidLon: number;
	/** Timestamp when this cluster was first observed. Tiebreaker for
	 *  matching: equidistant matches go to the older place, preserving
	 *  established identity over recently-created clusters. */
	firstSeenTs: number;
}

export interface NewCluster {
	centroidLat: number;
	centroidLon: number;
}

export interface ClusterMatch {
	/** Index into the `newClusters` array passed to `matchClusters`. */
	newIndex: number;
	/** Existing focus_places.id this cluster identifies with; `null`
	 *  when there is no match (fresh cluster, will get a new id on
	 *  INSERT). */
	oldId: number | null;
}

export interface MatchResult {
	/** One entry per input new cluster, in input order. */
	matches: ClusterMatch[];
	/** Existing focus_places.ids that did not match any new cluster.
	 *  These rows should be deleted from the table. */
	deletedOldIds: number[];
}

/** Max distance (metres) between an existing and a new cluster centroid
 *  for them to be considered the same place. Sized to absorb the
 *  typical drift of cluster centroids when a year's worth of fixes are
 *  re-mined (10-50 m for a stable place) plus the long tail of a
 *  cluster that shifts a city block as new fixes accumulate. */
const MATCH_RADIUS_M = 150;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface CandidatePair {
	oldIndex: number;
	newIndex: number;
	distanceM: number;
	firstSeenTs: number;
}

export function matchClusters(oldClusters: readonly ExistingPlace[], newClusters: readonly NewCluster[]): MatchResult {
	// Build the candidate pair list — every (old, new) within radius.
	const pairs: CandidatePair[] = [];
	for (let i = 0; i < oldClusters.length; i++) {
		const o = oldClusters[i];
		for (let j = 0; j < newClusters.length; j++) {
			const n = newClusters[j];
			const d = haversineMeters(o.centroidLat, o.centroidLon, n.centroidLat, n.centroidLon);
			if (d <= MATCH_RADIUS_M) {
				pairs.push({ oldIndex: i, newIndex: j, distanceM: d, firstSeenTs: o.firstSeenTs });
			}
		}
	}

	// Closest first, then prefer older existing place as tiebreaker.
	pairs.sort((a, b) => {
		if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
		return a.firstSeenTs - b.firstSeenTs;
	});

	const assignedOld = new Set<number>();
	const assignedNew = new Map<number, number>(); // newIndex -> oldId

	for (const p of pairs) {
		if (assignedOld.has(p.oldIndex) || assignedNew.has(p.newIndex)) continue;
		assignedOld.add(p.oldIndex);
		assignedNew.set(p.newIndex, oldClusters[p.oldIndex].id);
	}

	const matches: ClusterMatch[] = newClusters.map((_, j) => ({
		newIndex: j,
		oldId: assignedNew.get(j) ?? null,
	}));

	const deletedOldIds: number[] = [];
	for (let i = 0; i < oldClusters.length; i++) {
		if (!assignedOld.has(i)) deletedOldIds.push(oldClusters[i].id);
	}

	return { matches, deletedOldIds };
}
