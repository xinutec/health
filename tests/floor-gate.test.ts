import { describe, expect, it } from "vitest";
import { gateFloor, ratchetUpFloor } from "../src/eval/floor-gate.js";

/**
 * The one-way floor (`src/eval/floor-gate.ts`) shared by the journey ratchet and
 * the truth-row ratchet (#379). `gateFloor` is covered through its journey-shaped
 * name in `journey-gate.test.ts`; what needs its own tests is `ratchetUpFloor` —
 * the bless side, where the difference between "fixed it" and "quietly stopped
 * claiming it" lives.
 */
describe("ratchetUpFloor", () => {
	it("adds what the run satisfies now", () => {
		const r = ratchetUpFloor({ "2026-05-15": [100] }, { "2026-05-15": [100, 200] }, { "2026-05-15": [100, 200] });
		expect(r.floor).toEqual({ "2026-05-15": [100, 200] });
		expect(r.dropped).toEqual([]);
	});

	it("KEEPS a committed key the run no longer satisfies — blessing wins must not bless losses", () => {
		const r = ratchetUpFloor({ "2026-05-15": [100, 200] }, { "2026-05-15": [100] }, { "2026-05-15": [100, 200] });
		expect(r.floor).toEqual({ "2026-05-15": [100, 200] });
		expect(r.dropped).toEqual([]);
	});

	it("drops a key the narrative no longer describes, and says so", () => {
		// The row was re-audited away (or its window moved). Holding the key would
		// fail forever on something nothing can satisfy — but the drop is named.
		const r = ratchetUpFloor({ "2026-05-20": [100, 200] }, { "2026-05-20": [100] }, { "2026-05-20": [100] });
		expect(r.floor).toEqual({ "2026-05-20": [100] });
		expect(r.dropped).toEqual([{ date: "2026-05-20", startTs: 200 }]);
	});

	it("passes an UNMEASURED day's floor through untouched", () => {
		// No entry in `described` at all — the fixture threw, or the narrative is
		// gone. A silence must not empty the floor.
		const r = ratchetUpFloor({ "2026-06-16": [100, 200] }, {}, {});
		expect(r.floor).toEqual({ "2026-06-16": [100, 200] });
		expect(r.dropped).toEqual([]);
	});

	it("distinguishes an unmeasured day from a day measured as empty", () => {
		const unmeasured = ratchetUpFloor({ "2026-06-16": [100] }, {}, {});
		const emptied = ratchetUpFloor({ "2026-06-16": [100] }, { "2026-06-16": [] }, { "2026-06-16": [] });
		expect(unmeasured.floor).toEqual({ "2026-06-16": [100] });
		expect(emptied.floor).toEqual({ "2026-06-16": [] });
		expect(emptied.dropped).toEqual([{ date: "2026-06-16", startTs: 100 }]);
	});

	it("bootstraps a day the floor has never seen", () => {
		const r = ratchetUpFloor({}, { "2026-07-17": [300] }, { "2026-07-17": [300] });
		expect(r.floor).toEqual({ "2026-07-17": [300] });
	});

	it("keeps each day's keys sorted and deduplicated", () => {
		const r = ratchetUpFloor({ "2026-05-15": [300, 100] }, { "2026-05-15": [200, 100] }, { "2026-05-15": [100, 300] });
		expect(r.floor["2026-05-15"]).toEqual([100, 200, 300]);
	});
});

describe("gateFloor", () => {
	it("reads a day absent from the current run as losing every key", () => {
		// Deliberate: the caller owns the decision to exclude an unmeasurable day,
		// because only the caller knows WHY it is missing.
		const r = gateFloor({ "2026-06-16": [100, 200] }, {});
		expect(r.regressed).toHaveLength(2);
	});

	it("treats a key satisfied now but absent from the floor as an improvement", () => {
		const r = gateFloor({ "2026-06-16": [100] }, { "2026-06-16": [100, 200] });
		expect(r.regressed).toEqual([]);
		expect(r.improved).toEqual([{ date: "2026-06-16", startTs: 200 }]);
	});
});
