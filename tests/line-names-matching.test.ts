/**
 * `lineNamesMatching` resolves a line's base token to the exact set of
 * osm_lines names that contain it — the same set the old
 * `name LIKE '%base%'` query matched, but against a cached name list so
 * the geometry fetch can be an indexed `IN` lookup instead of a
 * leading-wildcard full scan (the 24-minute interchange-split bug).
 *
 * The equivalence that matters: for a given line name, `lineNamesMatching`
 * must select precisely the names a case-insensitive `%base%` LIKE would.
 */

import { describe, expect, it } from "vitest";
import { lineNamesMatching } from "../src/geo/line-stations.js";

describe("lineNamesMatching", () => {
	it("matches the exact line name", () => {
		const all = ["Victoria Line", "Jubilee Line", "Northern Line"];
		expect(lineNamesMatching("Victoria Line", all)).toEqual(["Victoria Line"]);
	});

	it("matches compound-tagged track sections sharing the base token", () => {
		// The motivating case: a line's central track is tagged with a
		// compound name listing several lines. Exact-name matching dropped
		// those sections (and the stations on them); the base token must
		// still find them.
		const all = ["Metropolitan Line", "Circle, Hammersmith & City and Metropolitan lines", "Jubilee Line"];
		expect(lineNamesMatching("Metropolitan Line", all)).toEqual([
			"Metropolitan Line",
			"Circle, Hammersmith & City and Metropolitan lines",
		]);
	});

	it("is case-insensitive (mirrors the default LIKE collation)", () => {
		expect(lineNamesMatching("victoria line", ["Victoria Line"])).toEqual(["Victoria Line"]);
	});

	it("strips a multi-word ' Lines' suffix to the base token", () => {
		const all = ["Circle and District Lines", "Carfaxloo Line"];
		expect(lineNamesMatching("Circle and District Lines", all)).toEqual(["Circle and District Lines"]);
	});

	it("returns no matches when nothing contains the base", () => {
		expect(lineNamesMatching("Piccadilly Line", ["Victoria Line", "Jubilee Line"])).toEqual([]);
	});

	it("returns nothing for a degenerate name that strips to empty", () => {
		// "Lines" → base "" — must not match every row (the old LIKE
		// '%%' would have; the indexed path must stay conservative).
		expect(lineNamesMatching("Lines", ["Victoria Line", "Jubilee Line"])).toEqual([]);
	});

	it("selects exactly what a case-insensitive '%base%' LIKE would", () => {
		// Property check against a reference substring implementation.
		const all = [
			"Victoria Line",
			"District Line",
			"Circle and District Lines",
			"East London Line",
			"London Overground",
			"Metropolitan Line",
			"Circle, Hammersmith & City and Metropolitan lines",
		];
		for (const name of all) {
			const base = name.replace(/\s+lines?\b.*$/i, "").trim();
			const reference = base.length === 0 ? [] : all.filter((n) => n.toLowerCase().includes(base.toLowerCase()));
			expect(lineNamesMatching(name, all)).toEqual(reference);
		}
	});
});
