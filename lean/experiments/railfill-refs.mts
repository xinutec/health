#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.Geo.RailRouteFill` from V8.
 *
 * `unsnappedTrainRoutes` decides which train legs of a computed day are worth a
 * background route fill: labelled, not already snapped, and pooled by key so the
 * same route ridden twice in a day is one fill rather than two. Every one of
 * those clauses is easy to get silently wrong in a way that still produces a
 * well-formed list:
 *
 *   - `refinedMode ?? mode` — the REFINED mode decides, so a leg refined AWAY
 *     from train is not a candidate and one refined INTO train is;
 *   - an absent `wayName` is skipped, because the label IS the cache key;
 *   - a leg that already has `snappedPath` is skipped — it is drawn on rails
 *     already, and re-filling it would recompute a row the nightly job owns;
 *   - the fix window is INCLUSIVE at both ends;
 *   - legs sharing a key POOL their fixes, and the retained window is the FIRST
 *     leg's, not the union — a real asymmetry, not an oversight to tidy;
 *   - insertion order is preserved (Map iteration order), so the queue is in the
 *     order the day was walked.
 *
 * The expectations below are what the REAL `src/geo/rail-route-fill.ts` does
 * under Node, printed for pasting into the Lean twin verbatim.
 *
 * Run: npx tsx lean/experiments/railfill-refs.mts
 */
import { type FillSegment, unsnappedTrainRoutes } from "../../src/geo/rail-route-fill.js";

const pts = [
	{ ts: 100, lat: 51.5, lon: -0.1 },
	{ ts: 150, lat: 51.51, lon: -0.11 },
	{ ts: 200, lat: 51.52, lon: -0.12 },
	{ ts: 300, lat: 51.53, lon: -0.13 },
	{ ts: 400, lat: 51.54, lon: -0.14 },
];

const show = (label: string, segs: FillSegment[]) => {
	const out = unsnappedTrainRoutes(segs, pts);
	console.log(
		`${label}: ${JSON.stringify(
			out.map((c) => ({ key: c.key, start: c.seg.startTs, end: c.seg.endTs, fixes: c.fixes.length })),
		)}`,
	);
};

const seg = (o: Partial<FillSegment>): FillSegment => ({ mode: "train", startTs: 100, endTs: 200, ...o });

// The plain case: one labelled, unsnapped train leg.
show("one candidate", [seg({ wayName: "A → B · L" })]);
// Not a train.
show("walk", [seg({ mode: "walk", wayName: "A → B" })]);
// refinedMode wins in BOTH directions.
show("refined away from train", [seg({ mode: "train", refinedMode: "car", wayName: "A → B" })]);
show("refined into train", [seg({ mode: "car", refinedMode: "train", wayName: "A → B" })]);
// No label — nothing to key a cache row on.
show("no wayName", [seg({})]);
// Already drawn on rails.
show("already snapped", [seg({ wayName: "A → B", snappedPath: [{ lat: 1, lon: 2 }] })]);
// ⚠ Inclusive at both ends: ts 100 and ts 200 are both inside [100, 200].
show("inclusive window", [seg({ wayName: "A → B", startTs: 100, endTs: 200 })]);
// ⚠ Two legs, one key: fixes POOL and the FIRST leg's window is the one kept.
show("pooled", [
	seg({ wayName: "A → B", startTs: 100, endTs: 200 }),
	seg({ wayName: "A → B", startTs: 300, endTs: 400 }),
]);
// Two keys stay two candidates, in the order the day was walked.
show("two keys", [
	seg({ wayName: "B → C", startTs: 300, endTs: 400 }),
	seg({ wayName: "A → B", startTs: 100, endTs: 200 }),
]);
// A leg whose window contains no fix is still a candidate — the label is the
// cache key, and the corridor evidence may be empty.
show("no fixes in window", [seg({ wayName: "A → B", startTs: 900, endTs: 950 })]);
show("empty day", []);
