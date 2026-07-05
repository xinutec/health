import { describe, expect, it } from "vitest";
import { parseStepsDataset, type StepsApiResponse } from "../src/fitbit/sync/steps.js";

describe("parseStepsDataset", () => {
	const r = (dataset: Array<{ time: string; value: number }>): StepsApiResponse => ({
		"activities-steps": [{ dateTime: "2026-05-10", value: "0" }],
		"activities-steps-intraday": { dataset },
	});

	it("returns empty rows for an empty dataset", () => {
		expect(parseStepsDataset(r([]), "u1", "2026-05-10")).toEqual([]);
	});

	it("returns empty rows when the intraday block is missing", () => {
		const empty = { "activities-steps": [{ dateTime: "2026-05-10", value: "0" }] };
		expect(parseStepsDataset(empty, "u1", "2026-05-10")).toEqual([]);
	});

	it("skips zero-step minutes (implicit-zero storage)", () => {
		const rows = parseStepsDataset(
			r([
				{ time: "00:00:00", value: 0 },
				{ time: "00:01:00", value: 5 },
				{ time: "00:02:00", value: 0 },
			]),
			"u1",
			"2026-05-10",
		);
		// Default TzSource (NULL_TZ_SOURCE) → tz=null and ts_utc=null in trailing slots.
		expect(rows).toEqual([["u1", "2026-05-10 00:01:00", 5, null, null]]);
	});

	it("emits one row per non-zero minute", () => {
		const rows = parseStepsDataset(
			r([
				{ time: "08:30:00", value: 100 },
				{ time: "08:31:00", value: 110 },
				{ time: "08:32:00", value: 95 },
			]),
			"alice",
			"2026-05-10",
		);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toEqual(["alice", "2026-05-10 08:30:00", 100, null, null]);
		expect(rows[2]).toEqual(["alice", "2026-05-10 08:32:00", 95, null, null]);
	});

	it("populates the tz and ts_utc slots from the provided TzSource", () => {
		const tzSource = { forWallClock: (_d: string, _t: string) => "Europe/Amsterdam" };
		const rows = parseStepsDataset(
			r([
				{ time: "08:30:00", value: 100 },
				{ time: "08:31:00", value: 110 },
			]),
			"u1",
			"2026-05-10",
			tzSource,
		);
		// 08:30 CEST = 06:30 UTC
		expect(rows[0]).toEqual(["u1", "2026-05-10 08:30:00", 100, "Europe/Amsterdam", "2026-05-10 06:30:00"]);
		expect(rows[1][3]).toBe("Europe/Amsterdam");
		expect(rows[1][4]).toBe("2026-05-10 06:31:00");
	});
});
