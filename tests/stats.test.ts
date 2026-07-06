import { describe, expect, it } from "vitest";
import { latestAndBaseline } from "../src/stats.js";

describe("latestAndBaseline", () => {
	it("returns null for an empty or all-null series", () => {
		expect(latestAndBaseline([])).toBeNull();
		expect(latestAndBaseline([{ date: "2026-07-01", value: null }])).toBeNull();
	});

	it("takes the newest value and baselines the earlier days", () => {
		const s = latestAndBaseline([
			{ date: "2026-07-01", value: 40 },
			{ date: "2026-07-03", value: 60 }, // newest
			{ date: "2026-07-02", value: 50 },
		]);
		expect(s?.latest).toBe(60);
		expect(s?.mean).toBe(45); // (40 + 50) / 2
		expect(s?.n).toBe(2);
	});

	it("drops null days from the baseline", () => {
		const s = latestAndBaseline([
			{ date: "2026-07-01", value: 40 },
			{ date: "2026-07-02", value: null },
			{ date: "2026-07-03", value: 50 },
		]);
		expect(s?.latest).toBe(50);
		expect(s?.mean).toBe(40);
		expect(s?.n).toBe(1);
	});

	it("a single value has no baseline (n=0)", () => {
		expect(latestAndBaseline([{ date: "2026-07-03", value: 55 }])).toEqual({
			latest: 55,
			mean: 55,
			sd: 0,
			n: 0,
		});
	});
});
