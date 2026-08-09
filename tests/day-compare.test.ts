import { describe, expect, it } from "vitest";
import { canon, classify, diffEpisodes, diffSegs, SHELLED } from "../src/lean/day-compare.js";

/**
 * What "the two arms agree" MEANS for a Lean day.
 *
 * The rule lived inline in `compare-day.ts` with no tests, and the `LEAN_DAY`
 * tenant restated it from memory — with `snappedPath` added to the excuse list,
 * which the gate deliberately excludes. The two comparators would then have
 * reported the same regression as EXACT and DIVERGED respectively, and only the
 * gate's verdict would have stopped a deploy. These tests pin the rule so a
 * second caller cannot drift from it again.
 */

const seg = (fields: Record<string, unknown>): Record<string, unknown> => ({ mode: "walking", ...fields });

describe("diffSegs", () => {
	it("names the field and the count, not the segment", () => {
		const d = diffSegs([seg({ place: "a" }), seg({ place: "b" })], [seg({ place: "a" }), seg({ place: "z" })]);
		expect(d).toEqual(["place: 1/2 segments differ"]);
	});

	it("reports a count mismatch and still compares the overlap", () => {
		const d = diffSegs([seg({ place: "a" }), seg({ place: "b" })], [seg({ place: "z" })]);
		expect(d).toEqual(["segment count: TS 2, Lean 1", "place: 1/1 segments differ"]);
	});

	// The defect `canon` exists for: both arms hold identical values, built in
	// different key orders. Comparing raw renderings called all of them different.
	it("is insensitive to key order", () => {
		const d = diffSegs([{ a: 1, b: { x: 1, y: 2 } }], [{ b: { y: 2, x: 1 }, a: 1 }]);
		expect(d).toEqual([]);
	});

	// A field present on one side only is a difference, not a skip — an arm that
	// stopped writing a field would otherwise pass.
	it("counts a field only one arm wrote", () => {
		expect(diffSegs([{ a: 1, wayName: "X" }], [{ a: 1 }])).toEqual(["wayName: 1/1 segments differ"]);
	});

	it("orders fields by how many segments they differ on", () => {
		const want = [seg({ p: 1, q: 1 }), seg({ p: 1, q: 1 })];
		const got = [seg({ p: 2, q: 1 }), seg({ p: 2, q: 2 })];
		expect(diffSegs(want, got)).toEqual(["p: 2/2 segments differ", "q: 1/2 segments differ"]);
	});

	it("passes each difference to a sample sink when one is given", () => {
		const seen: string[] = [];
		diffSegs([seg({ place: "a" })], [seg({ place: "z" })], (label, i) => seen.push(`${label}@${i}`));
		expect(seen).toEqual(["place@0"]);
	});
});

const ep = (kind: string, points: unknown[], rest: Record<string, unknown> = {}): Record<string, unknown> => ({
	kind,
	points,
	...rest,
});

describe("diffEpisodes", () => {
	// Excuse 1, measured 2026-05-18: TS drew it with the solver the fold is not
	// fed, Lean fell back to raw chords. `kind` and `points` are that absence.
	it("excuses a solver-drawn episode the Lean arm drew raw", () => {
		const r = diffEpisodes([ep("matched", [1, 2, 3], { mode: "walking" })], [ep("raw", [1, 3], { mode: "walking" })]);
		expect(r.real).toEqual([]);
		expect(r.fallback).toBe(1);
	});

	// The excuse is exactly two fields wide. A fallback that also moved the mode
	// is a real divergence, and the excuse must not swallow it.
	it("still compares every other field of an excused episode", () => {
		const r = diffEpisodes([ep("matched", [1, 2], { mode: "walking" })], [ep("raw", [1], { mode: "train" })]);
		expect(r.real).toEqual(["episodes.mode: 1/1 differ"]);
		expect(r.fallback).toBe(1);
	});

	// Not a fallback: the arms disagree about what KIND of thing happened, which
	// no missing solver explains.
	it("does not excuse a kind disagreement that is not solver-to-raw", () => {
		const r = diffEpisodes([ep("anchor", [1])], [ep("raw", [1])]);
		expect(r.real).toEqual(["episodes.kind: 1/1 differ"]);
		expect(r.fallback).toBe(0);
	});

	// Excuse 2, measured on four days: a connector joins its neighbours' drawn
	// ends, so when the neighbour was drawn by the missing matcher the joint moves
	// with it. Excused only for the vertex that equals that neighbour's terminal
	// vertex IN ITS OWN ARM.
	it("excuses a connector vertex inherited from a fallback neighbour", () => {
		const want = [ep("matched", ["a", "TS-end"]), ep("tentative", ["TS-end", "z"])];
		const got = [ep("raw", ["a", "LEAN-end"]), ep("tentative", ["LEAN-end", "z"])];
		expect(diffEpisodes(want, got).real).toEqual([]);
	});

	it("does not excuse a connector whose free end moved", () => {
		const want = [ep("matched", ["a", "TS-end"]), ep("tentative", ["TS-end", "z"])];
		const got = [ep("raw", ["a", "LEAN-end"]), ep("tentative", ["LEAN-end", "MOVED"])];
		expect(diffEpisodes(want, got).real).toEqual(["episodes.points: 1/2 differ"]);
	});

	// A connector next to a neighbour that matched has no excuse to inherit.
	it("does not excuse a connector whose neighbour was not a fallback", () => {
		const want = [ep("matched", ["a", "TS-end"]), ep("tentative", ["TS-end", "z"])];
		const got = [ep("matched", ["a", "LEAN-end"]), ep("tentative", ["LEAN-end", "z"])];
		const r = diffEpisodes(want, got);
		expect(r.fallback).toBe(0);
		expect(r.real).toEqual(["episodes.points: 2/2 differ"]);
	});

	it("reports a count mismatch", () => {
		expect(diffEpisodes([ep("raw", [1]), ep("raw", [2])], [ep("raw", [1])]).real).toEqual([
			"episodes count: TS 2, Lean 1",
		]);
	});
});

describe("classify", () => {
	it("sends a declared shell field to the shell list", () => {
		const r = classify(["walkMatchedPath: 6/15 segments differ"], 0);
		expect(r.real).toEqual([]);
		expect(r.shell).toEqual(["walkMatchedPath: 6/15 segments differ"]);
	});

	// The regression the extraction was for. The tenant's own list excused
	// `snappedPath`; the gate never has, because `railSnap` reads
	// `railRouteCache` and the payload supplies it, so that field has to match.
	it("treats snappedPath as a real divergence, not a shell", () => {
		expect(SHELLED.has("snappedPath")).toBe(false);
		expect(classify(["snappedPath: 1/15 segments differ"], 0).real).toEqual(["snappedPath: 1/15 segments differ"]);
	});

	// The prefix is what keeps an interior boundary honest: before the fold has
	// run there is no matcher output to be missing, so a shelled field differing
	// THERE is a real divergence.
	it("does not excuse a shelled field at an interior boundary", () => {
		expect(classify(["pre.walkMatchedPath: 2/15 segments differ"], 0).real).toEqual([
			"pre.walkMatchedPath: 2/15 segments differ",
		]);
	});

	it("records the fallback count as a shell line", () => {
		const r = classify([], 3);
		expect(r.real).toEqual([]);
		expect(r.shell).toEqual(["episodes drawn raw for want of a matcher: 3"]);
	});

	it("says nothing about fallbacks when there are none", () => {
		expect(classify([], 0)).toEqual({ real: [], shell: [] });
	});

	it("keeps a real difference out of the shell list even beside a shelled one", () => {
		const r = classify(["matchedPath: 1/2 segments differ", "place: 1/2 segments differ"], 0);
		expect(r.real).toEqual(["place: 1/2 segments differ"]);
		expect(r.shell).toEqual(["matchedPath: 1/2 segments differ"]);
	});
});

describe("canon", () => {
	it("sorts object keys at every depth", () => {
		expect(canon({ b: 1, a: { d: 2, c: 3 } })).toBe(canon({ a: { c: 3, d: 2 }, b: 1 }));
	});

	// Arrays are ORDERED data — a reordered path is a different path.
	it("does not sort arrays", () => {
		expect(canon([1, 2])).not.toBe(canon([2, 1]));
	});
});
