/**
 * The bus mirror writes per TILE, so a run that loses some tiles to Overpass
 * cannot shrink the cache: tiles that answered replace their own rows, tiles
 * that failed keep theirs. These pin the one refusal that is left (#255).
 *
 * The case worth stating is the one that made the old count-threshold wrong. It
 * compared cardinalities — refuse if the rebuild would drop below 80% of what
 * the cache held whenever any tile failed — and cardinality is not where the
 * harm lives. A run fetching 796 of 995 routes but losing the handful the rider
 * actually uses passed; a run dropping 300 untouched peripheral routes was
 * refused. Measured on prod 2026-08-14: two consecutive runs returned 726 and
 * 630 routes and were both refused, leaving the mirror 61 days stale — the
 * threshold could only ever choose between overwriting with a partial fetch and
 * keeping everything stale, because the writer had discarded WHICH tile failed.
 * Carrying that through to the write removes the choice.
 */

import { describe, expect, it } from "vitest";
import { rebuildRefusal } from "../src/geo/bus-route-cache.js";

describe("rebuildRefusal — the only run with nothing to write", () => {
	it("refuses when every tile failed and the cache holds something", () => {
		// Nothing authoritative was learned, so there is no tile to replace and
		// the merge would be a no-op that still stamps computed_at.
		expect(rebuildRefusal(995, 100, 100)).toMatch(/Every tile failed \(100\/100\)/);
		expect(rebuildRefusal(995, 18, 18)).toMatch(/995 route\(s\)/);
	});

	it("allows a complete run whatever it found", () => {
		// Authoritative for the whole bbox, so a shrink is data: routes do leave
		// OSM and the home region can move.
		expect(rebuildRefusal(995, 0, 18)).toBeNull();
	});

	it("allows the partial runs the old count threshold refused", () => {
		// Both of these are real: 2026-08-14 returned 726 routes with 1/18 tiles
		// failed, then 630 with 6/18. Under the threshold both were refused and
		// the mirror stayed stale. Under a per-tile write, the tiles that
		// answered are simply replaced and the rest keep their rows.
		expect(rebuildRefusal(995, 1, 18)).toBeNull();
		expect(rebuildRefusal(995, 6, 18)).toBeNull();
		// The shape the old guard was built to catch — 90 of 100 tiles gone —
		// is now safe for the same reason: those 90 tiles keep what they had.
		expect(rebuildRefusal(995, 90, 100)).toBeNull();
	});

	it("lets the FIRST run populate an empty cache even if every tile failed", () => {
		// Nothing to protect. Refusing here would only keep the cache empty.
		expect(rebuildRefusal(0, 100, 100)).toBeNull();
		expect(rebuildRefusal(0, 40, 90)).toBeNull();
	});

	it("does not refuse when there are no tiles at all", () => {
		// A degenerate bbox yields no tiles; that is a caller bug, not a reason
		// to report every tile as failed.
		expect(rebuildRefusal(995, 0, 0)).toBeNull();
	});
});
