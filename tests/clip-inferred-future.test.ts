import { describe, expect, it } from "vitest";
import type { DayState } from "../src/sleep/day-state.js";
import { clipInferredFuture } from "../src/sleep/day-state.js";

const NOW = 1000;

function st(startTs: number, endTs: number, inferred?: boolean): DayState {
	return { startTs, endTs, mode: "stationary", place: "Home", ...(inferred ? { inferred: true } : {}) };
}

describe("clipInferredFuture", () => {
	it("leaves observed states untouched, even past now (real data is real)", () => {
		const out = clipInferredFuture([st(0, 2000)], NOW);
		expect(out).toEqual([st(0, 2000)]);
	});

	it("truncates an inferred state straddling now to now", () => {
		const out = clipInferredFuture([st(0, 2000, true)], NOW);
		expect(out).toHaveLength(1);
		expect(out[0].endTs).toBe(NOW);
		expect(out[0].inferred).toBe(true);
	});

	it("drops an inferred state wholly in the future", () => {
		const out = clipInferredFuture([st(0, 500), st(1500, 2000, true)], NOW);
		expect(out).toHaveLength(1);
		expect(out[0].startTs).toBe(0);
	});

	it("keeps an inferred state wholly in the past", () => {
		const out = clipInferredFuture([st(0, 800, true)], NOW);
		expect(out).toHaveLength(1);
		expect(out[0].endTs).toBe(800);
	});
});
