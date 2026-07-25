/**
 * V8 reference values for the pure passes in `src/geo/passes/rail-reconcile.ts`:
 *
 *   `mergeAdjacentSameRouteTrains` — one tube journey left as two adjacent
 *                                    train segments with the same station pair
 *   `reconcileAdjacentRailLegs`    — the day-grammar law that back-to-back rail
 *                                    legs must share a station, enforced
 *   `annotateSnappedPaths`         — attach the cached route geometry to a run
 *
 * `assembleRailJourney` is async (OSM line/station lookups) and stays shell.
 *
 * Note `trainStationPair` (private, driven through the merge) tests the BARE
 * arrow `"→"`, not `" → "` with spaces, and splits on `" · "` then trims —
 * a fourth reading of the same label, looser than either parser. A case below
 * pins it with a label whose arrow has no surrounding spaces.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/rail-reconcile-refs.mts
 */

import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";
import {
	annotateSnappedPaths,
	mergeAdjacentSameRouteTrains,
	reconcileAdjacentRailLegs,
} from "../../src/geo/passes/rail-reconcile.js";
import type { SnappedPoint } from "../../src/geo/rail-snap.js";
import type { TransportMode } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(1000)", north(1000));

function seg(
	startTs: number,
	endTs: number,
	mode: TransportMode,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 2,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0.5,
		pointCount: 10,
		...extra,
	};
}

const PATH: SnappedPoint[] = [{ lat: LAT0, lon: LON0, ts: 0 }];

/* ------------------------------------------------------------------ */
/* 1. mergeAdjacentSameRouteTrains                                     */
/* ------------------------------------------------------------------ */

const MERGE_CASES: Record<string, EnrichedSegment[]> = {
	// The same board→alight pair split into two adjacent legs: merged, with the
	// numeric fields point-count weighted at each field's own precision.
	sameePair: [
		seg(0, 600, "train", {
			wayName: "A → B",
			pointCount: 10,
			avgSpeed: 30.4,
			maxSpeed: 44.2,
			linearity: 0.81,
		}),
		seg(660, 1200, "train", {
			wayName: "A → B",
			pointCount: 30,
			avgSpeed: 40.6,
			maxSpeed: 52.8,
			linearity: 0.93,
		}),
	],
	// The pair is read BEFORE the line suffix, so two legs differing only in
	// their line label still merge — and the merged leg keeps the MORE SPECIFIC
	// name, the half that resolved a line.
	lineSuffixIgnoredForPairing: [
		seg(0, 600, "train", { wayName: "A → B" }),
		seg(660, 1200, "train", { wayName: "A → B · Metropolitan Line" }),
	],
	// …and the other way round: the first already has the line, so it is kept.
	keepsExistingLine: [
		seg(0, 600, "train", { wayName: "A → B · Metropolitan Line" }),
		seg(660, 1200, "train", { wayName: "A → B" }),
	],
	// Different pairs never merge.
	differentPairs: [seg(0, 600, "train", { wayName: "A → B" }), seg(660, 1200, "train", { wayName: "B → C" })],
	// 181 s is past the 3-minute bar; 180 exactly merges.
	gapTooBig: [seg(0, 600, "train", { wayName: "A → B" }), seg(781, 1200, "train", { wayName: "A → B" })],
	gapExactlyAtBar: [seg(0, 600, "train", { wayName: "A → B" }), seg(780, 1200, "train", { wayName: "A → B" })],
	// A label with no arrow at all is not a station pair.
	noArrow: [
		seg(0, 600, "train", { wayName: "Metropolitan Line" }),
		seg(660, 1200, "train", { wayName: "Metropolitan Line" }),
	],
	// `trainStationPair` tests the BARE arrow and then TRIMS, so a label whose
	// arrow has no surrounding spaces still pairs — and pairs with the spaced
	// form, since both trim to the same string only if the text matches. Here
	// both legs use the tight form.
	bareArrowNoSpaces: [seg(0, 600, "train", { wayName: "A→B" }), seg(660, 1200, "train", { wayName: "A→B" })],
	// The pair is TRIMMED, so a label with a trailing space still pairs with the
	// clean form. Without the trim these two are different strings.
	trimmedPair: [seg(0, 600, "train", { wayName: "A → B " }), seg(660, 1200, "train", { wayName: "A → B" })],
	// The EARLIER leg's snappedPath is kept when the later one has none —
	// the adopt is one-directional.
	keepsEarlierSnappedPath: [
		seg(0, 600, "train", { wayName: "A → B", snappedPath: PATH }),
		seg(660, 1200, "train", { wayName: "A → B" }),
	],
	// Non-train legs are never paired.
	notTrains: [seg(0, 600, "walking", { wayName: "A → B" }), seg(660, 1200, "walking", { wayName: "A → B" })],
	// effectiveMode: a leg refined to train participates.
	refinedToTrain: [
		seg(0, 600, "driving", { refinedMode: "train", wayName: "A → B" }),
		seg(660, 1200, "train", { wayName: "A → B" }),
	],
	// A snappedPath is adopted from the later leg when the earlier has none.
	adoptsSnappedPath: [
		seg(0, 600, "train", { wayName: "A → B" }),
		seg(660, 1200, "train", { wayName: "A → B", snappedPath: PATH }),
	],
	// Both point counts zero: the `|| 1` guard stops a divide-by-zero producing
	// NaN in the weighted means.
	zeroPointCounts: [
		seg(0, 600, "train", { wayName: "A → B", pointCount: 0, avgSpeed: 30, maxSpeed: 44, linearity: 0.8 }),
		seg(660, 1200, "train", { wayName: "A → B", pointCount: 0, avgSpeed: 40, maxSpeed: 52, linearity: 0.9 }),
	],
	empty: [],
};
for (const [name, segs] of Object.entries(MERGE_CASES)) {
	show(
		`merge.${name}`,
		mergeAdjacentSameRouteTrains(segs).map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			pointCount: s.pointCount,
			avgSpeed: s.avgSpeed,
			maxSpeed: s.maxSpeed,
			linearity: s.linearity,
			wayName: s.wayName ?? null,
			hasSnapped: s.snappedPath !== undefined,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 2. reconcileAdjacentRailLegs                                        */
/* ------------------------------------------------------------------ */

const RECONCILE_CASES: Record<string, EnrichedSegment[]> = {
	// DISTINCT alights: leg B continues the journey, so it is rewritten to board
	// where leg A alighted. Only the station label changes.
	distinctAlights: [
		seg(0, 600, "train", { wayName: "A → S" }),
		seg(600, 1200, "train", { wayName: "T0 → T · Jubilee Line" }),
	],
	// …and without a line the suffix is omitted entirely.
	distinctAlightsNoLine: [
		seg(0, 600, "train", { wayName: "A → S" }),
		seg(600, 1200, "train", { wayName: "T0 → T" }),
	],
	// SAME alight: leg B claims a ride to a station already reached, with no
	// travel between — physically impossible and not rewritable without
	// collapsing to "S → S". Leg B is absorbed into A (the 2026-06-22 bug).
	sameAlight: [
		seg(0, 600, "train", { wayName: "A → S", maxSpeed: 40 }),
		seg(600, 1200, "train", { wayName: "B → S", maxSpeed: 55, pointCount: 7, snappedPath: PATH }),
	],
	// Already consistent: A alights where B boards. Untouched.
	alreadyConsistent: [
		seg(0, 600, "train", { wayName: "A → S" }),
		seg(600, 1200, "train", { wayName: "S → T" }),
	],
	// An unparseable label on either side stops the reconciliation.
	unparseableA: [seg(0, 600, "train", { wayName: "Metropolitan Line" }), seg(600, 1200, "train", { wayName: "T0 → T" })],
	missingLabelB: [seg(0, 600, "train", { wayName: "A → S" }), seg(600, 1200, "train")],
	// Not two trains.
	notBothTrains: [seg(0, 600, "walking", { wayName: "A → S" }), seg(600, 1200, "train", { wayName: "T0 → T" })],
	// The absorb takes the LATER end and the LARGER max speed, so a leg B that
	// ends BEFORE A does not shorten it.
	sameAlightBEndsEarlier: [
		seg(0, 1200, "train", { wayName: "A → S", maxSpeed: 55 }),
		seg(600, 900, "train", { wayName: "B → S", maxSpeed: 40 }),
	],
	empty: [],
};
for (const [name, segs] of Object.entries(RECONCILE_CASES)) {
	show(
		`reconcile.${name}`,
		reconcileAdjacentRailLegs(segs).map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			pointCount: s.pointCount,
			maxSpeed: s.maxSpeed,
			wayName: s.wayName ?? null,
			hasSnapped: s.snappedPath !== undefined,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 3. annotateSnappedPaths                                             */
/* ------------------------------------------------------------------ */

const GEOM = [north(0), north(1000)];
const CACHE = [{ routeKey: "A → B", geometryJson: JSON.stringify(GEOM) }];

const SNAP_CASES: Record<string, { segs: EnrichedSegment[]; cache: typeof CACHE }> = {
	// A cached route for the run's label: geometry attached, timestamps
	// interpolated across the segment's window by arc length.
	attached: { segs: [seg(1000, 2000, "train", { wayName: "A → B" })], cache: CACHE },
	// No cache row for this key.
	noCacheRow: { segs: [seg(1000, 2000, "train", { wayName: "C → D" })], cache: CACHE },
	// A single-vertex geometry is REJECTED (`length >= 2`) — nothing to draw.
	geometryTooShort: {
		segs: [seg(1000, 2000, "train", { wayName: "A → B" })],
		cache: [{ routeKey: "A → B", geometryJson: JSON.stringify([north(0)]) }],
	},
	// A malformed cache row is non-fatal: skipped, the run draws raw.
	malformedJson: {
		segs: [seg(1000, 2000, "train", { wayName: "A → B" })],
		cache: [{ routeKey: "A → B", geometryJson: "{not json" }],
	},
	// Non-train legs and unlabelled legs are never snapped. The walking leg here
	// shares its label with a train leg, so the cache lookup DOES have a usable
	// row — the per-segment mode test is what stops it, not an empty key set.
	notATrain: {
		segs: [seg(1000, 2000, "train", { wayName: "A → B" }), seg(2000, 3000, "walking", { wayName: "A → B" })],
		cache: CACHE,
	},
	noWayName: { segs: [seg(1000, 2000, "train")], cache: CACHE },
	empty: { segs: [], cache: CACHE },
};
for (const [name, c] of Object.entries(SNAP_CASES)) {
	show(
		`snap.${name}`,
		annotateSnappedPaths(c.segs, c.cache).map((s) => ({
			wayName: s.wayName ?? null,
			snappedPath: s.snappedPath ?? null,
		})),
	);
}
