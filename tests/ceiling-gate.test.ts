import { describe, expect, it } from "vitest";
import { gateCeiling, ratchetDownCounts } from "../src/eval/ceiling-gate.js";

/**
 * The count-shaped ratchet behind the kinematic-feasibility and rail-triple
 * gates. It lived inline in `golden-check.ts` with no tests, which is how the
 * unmeasured-day case below survived: every day always replayed, so nothing
 * ever exercised the difference between "no defects" and "not measured".
 */

const ALL = (...dates: string[]): ReadonlySet<string> => new Set(dates);

describe("gateCeiling", () => {
	it("fails a day above its ceiling", () => {
		const r = gateCeiling({ "2026-06-16": 1 }, { "2026-06-16": 2 }, ALL("2026-06-16"));
		expect(r.regressed).toEqual([{ date: "2026-06-16", was: 1, now: 2 }]);
		expect(r.improvedDays).toBe(0);
	});

	it("counts a day below its ceiling as an improvement", () => {
		const r = gateCeiling({ "2026-06-16": 1 }, {}, ALL("2026-06-16"));
		expect(r.regressed).toEqual([]);
		expect(r.improvedDays).toBe(1);
	});

	it("fails a day that offends with no committed ceiling — absent means zero", () => {
		const r = gateCeiling({}, { "2026-07-02": 1 }, ALL("2026-07-02"));
		expect(r.regressed).toEqual([{ date: "2026-07-02", was: 0, now: 1 }]);
	});

	// The defect this module was extracted for. A fixture that can no longer
	// replay produces no count at all, and `?? 0` read that silence as a clean
	// day: 2026-06-16 dropped out of the failures and the run printed "1 day(s)
	// improved" while its impossible leg was still there, unmeasured.
	it("names an unmeasured day rather than scoring it as zero", () => {
		const r = gateCeiling({ "2026-06-16": 1 }, {}, ALL());
		expect(r.unmeasured).toEqual(["2026-06-16"]);
		expect(r.improvedDays).toBe(0);
		expect(r.regressed).toEqual([]);
	});

	// A day at ceiling zero is in neither baseline, so only the attempted set can
	// name it — and it is the day a new defect hides best on, because it cannot
	// regress a ceiling it is no longer measured against.
	it("names a clean day that stopped replaying", () => {
		const r = gateCeiling({}, {}, ALL(), ALL("2026-06-16"));
		expect(r.unmeasured).toEqual(["2026-06-16"]);
		expect(r.improvedDays).toBe(0);
	});

	it("does not let an unmeasured day mask a regression elsewhere", () => {
		const r = gateCeiling({ "2026-06-16": 1, "2026-07-02": 1 }, { "2026-07-02": 3 }, ALL("2026-07-02"));
		expect(r.unmeasured).toEqual(["2026-06-16"]);
		expect(r.regressed).toEqual([{ date: "2026-07-02", was: 1, now: 3 }]);
	});
});

describe("ratchetDownCounts", () => {
	it("takes the lower of committed and current, per day", () => {
		expect(ratchetDownCounts({ a: 3 }, { a: 1 }, ALL("a"))).toEqual({ a: 1 });
	});

	// A bless run that fixes one day and leaves another red must not raise the
	// red day's ceiling — the losses do not ride in on the wins.
	it("keeps the committed value for a day that got worse", () => {
		expect(ratchetDownCounts({ a: 3, b: 1 }, { a: 1, b: 4 }, ALL("a", "b"))).toEqual({ a: 1, b: 1 });
	});

	it("drops a day with no defects left", () => {
		expect(ratchetDownCounts({ a: 2 }, {}, ALL("a"))).toEqual({});
	});

	it("cannot bless in a newly-offending day by omission", () => {
		expect(ratchetDownCounts({}, { a: 2 }, ALL("a"))).toEqual({});
	});

	it("bootstraps from the run when there is no baseline file at all", () => {
		expect(ratchetDownCounts(null, { a: 2 }, ALL("a"))).toEqual({ a: 2 });
	});

	// The bless half of the same defect: an unmeasured day must keep its ceiling
	// rather than be recorded as fixed. Dropping it writes a zero nobody
	// observed, and the day then fails the moment it replays again.
	it("holds an unmeasured day's ceiling instead of recording a fix", () => {
		expect(ratchetDownCounts({ a: 2, b: 1 }, { b: 1 }, ALL("b"))).toEqual({ a: 2, b: 1 });
	});
});
