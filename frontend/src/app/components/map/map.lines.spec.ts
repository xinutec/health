import { describe, expect, it } from "vitest";
import { lineRuns } from "./map.lines";

const p = (n: number, inferred?: boolean) => ({ lat: n, lon: -n, ...(inferred ? { inferred } : {}) });

describe("an episode's line as solid and dashed runs", () => {
	it("is one solid run when no edge is inferred", () => {
		expect(lineRuns([p(0), p(1), p(2)], false)).toEqual([
			{ coords: [[0, -0], [1, -1], [2, -2]], dashed: false },
		]);
	});

	it("dashes the edge arriving at an inferred point, and only it", () => {
		expect(lineRuns([p(0), p(1), p(2, true), p(3)], false)).toEqual([
			{ coords: [[0, -0], [1, -1]], dashed: false },
			{ coords: [[1, -1], [2, -2]], dashed: true },
			{ coords: [[2, -2], [3, -3]], dashed: false },
		]);
	});

	it("keeps consecutive inferred edges in one run, joined to its neighbours", () => {
		const runs = lineRuns([p(0), p(1, true), p(2, true), p(3)], false);
		expect(runs.map((r) => r.dashed)).toEqual([true, false]);
		expect(runs[0].coords).toEqual([[0, -0], [1, -1], [2, -2]]);
		expect(runs[1].coords[0]).toEqual([2, -2]);
	});

	it("dashes everything for an episode that is inferred as a whole", () => {
		expect(lineRuns([p(0), p(1), p(2)], true)).toEqual([
			{ coords: [[0, -0], [1, -1], [2, -2]], dashed: true },
		]);
	});

	it("ignores the first point's flag: no edge arrives at it", () => {
		expect(lineRuns([p(0, true), p(1)], false)).toEqual([{ coords: [[0, -0], [1, -1]], dashed: false }]);
	});

	it("draws nothing for fewer than two points", () => {
		expect(lineRuns([p(0)], false)).toEqual([]);
		expect(lineRuns([], true)).toEqual([]);
	});
});
