/**
 * `rleDurDelta` — the run-length encoding of the class-factorised duration
 * delta tensor over `e`, the wire format the Lean parser expands back before
 * decoding. The corpus shadow is the byte-identical round-trip gate; these
 * pin the encoder's shape and the property the Lean side relies on: each row's
 * runs cover exactly the original length and reconstruct it value-for-value.
 */

import { describe, expect, it } from "vitest";
import { rleDurDelta } from "../src/hmm/lean-shadow-core.js";

/** Mirror of the Lean expander: flatten runs back to the dense row. */
const expand = (runs: readonly [number, number][]): number[] => {
	const out: number[] = [];
	for (const [v, len] of runs) for (let i = 0; i < len; i++) out.push(v);
	return out;
};

describe("rleDurDelta", () => {
	it("collapses adjacent equal values into [value, runLength] runs", () => {
		expect(rleDurDelta([[[5, 5, 5, 3, 3]]])).toEqual([
			[
				[
					[5, 3],
					[3, 2],
				],
			],
		]);
	});

	it("keeps a strictly-varying row one run per cell (worst case, no smaller)", () => {
		expect(rleDurDelta([[[1, 2, 3]]])).toEqual([
			[
				[
					[1, 1],
					[2, 1],
					[3, 1],
				],
			],
		]);
	});

	it("encodes a constant row as a single run", () => {
		expect(rleDurDelta([[[7, 7, 7, 7]]])).toEqual([[[[7, 4]]]]);
	});

	it("preserves class and d structure, RLE only the innermost e axis", () => {
		const t = [
			[
				[0, 0, 1],
				[2, 2, 2],
			],
			[[9, 8, 8]],
		];
		const rle = rleDurDelta(t);
		expect(rle).toHaveLength(2);
		expect(rle[0]).toHaveLength(2);
		expect(rle[1]).toHaveLength(1);
		// round-trips the whole tensor row-for-row
		for (let c = 0; c < t.length; c++) for (let d = 0; d < t[c].length; d++) expect(expand(rle[c][d])).toEqual(t[c][d]);
	});

	it("round-trips runs summing to the original row length, including negatives", () => {
		const row = [-3, -3, 0, 0, 0, 5, -3];
		const [[runs]] = rleDurDelta([[row]]);
		expect(runs.reduce((n, [, len]) => n + len, 0)).toBe(row.length);
		expect(expand(runs)).toEqual(row);
	});

	it("handles empty tensors and empty rows", () => {
		expect(rleDurDelta([])).toEqual([]);
		expect(rleDurDelta([[[]]])).toEqual([[[]]]);
	});
});
