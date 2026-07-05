import { describe, expect, it } from "vitest";
import { gateJourneys } from "../src/eval/journey-gate.js";

/**
 * The journey ratchet (`src/eval/journey-gate.ts`): a previously-reconstructed
 * journey breaking is a failure; a newly-correct one is an improvement to
 * re-bless. Mirrors the worldline-feasibility gate but with a non-zero baseline.
 */
describe("gateJourneys", () => {
	it("is clean when current matches the baseline exactly", () => {
		const r = gateJourneys({ "2026-05-22": [100, 200] }, { "2026-05-22": [100, 200] });
		expect(r.regressed).toEqual([]);
		expect(r.improved).toEqual([]);
	});

	it("flags a baseline journey that no longer reconstructs as a regression", () => {
		const r = gateJourneys({ "2026-05-22": [100, 200] }, { "2026-05-22": [100] });
		expect(r.regressed).toEqual([{ date: "2026-05-22", startTs: 200 }]);
		expect(r.improved).toEqual([]);
	});

	it("flags a newly-correct journey as an improvement, not a failure", () => {
		const r = gateJourneys({ "2026-05-22": [100] }, { "2026-05-22": [100, 200] });
		expect(r.regressed).toEqual([]);
		expect(r.improved).toEqual([{ date: "2026-05-22", startTs: 200 }]);
	});

	it("treats a day absent from the baseline as bootstrap — improvements only", () => {
		const r = gateJourneys({}, { "2026-06-16": [500] });
		expect(r.regressed).toEqual([]);
		expect(r.improved).toEqual([{ date: "2026-06-16", startTs: 500 }]);
	});

	it("treats a whole day missing from current as regressions of its baseline", () => {
		const r = gateJourneys({ "2026-05-22": [100, 200] }, {});
		expect(r.regressed).toEqual([
			{ date: "2026-05-22", startTs: 100 },
			{ date: "2026-05-22", startTs: 200 },
		]);
	});
});
