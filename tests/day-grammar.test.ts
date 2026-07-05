import { describe, expect, it } from "vitest";
import { checkDayConstraints, parseStationPair } from "../src/infer/day-grammar.js";
import type { DayState, DayStateMode } from "../src/sleep/day-state.js";

let t = 0;
function st(mode: DayStateMode, extra: Partial<DayState> = {}): DayState {
	const s: DayState = { startTs: t, endTs: t + 600, mode, ...extra };
	t += 600;
	return s;
}

describe("parseStationPair", () => {
	it("parses a board → alight · line label", () => {
		expect(parseStationPair("Deepwell → Ashvale · Metropolitan Line")).toEqual({
			board: "Deepwell",
			alight: "Ashvale",
		});
	});
	it("returns null for a road name or absent label", () => {
		expect(parseStationPair("Deepwell Underpass")).toBeNull();
		expect(parseStationPair(undefined)).toBeNull();
	});
});

describe("checkDayConstraints", () => {
	it("passes a physically-possible day", () => {
		t = 0;
		const day = [
			st("sleeping", { place: "Home" }),
			st("walking"),
			st("train", { wayName: "Ashvale → Deepwell · Metropolitan Line" }),
			st("walking"),
			st("stationary", { place: "UCLH" }),
			st("walking"),
			st("train", { wayName: "Deepwell → Ashvale · Metropolitan Line" }),
			st("walking"),
			st("stationary", { place: "Home" }),
		];
		expect(checkDayConstraints(day)).toEqual([]);
	});

	it("flags a direct vehicle→vehicle hand-off (the 2026-06-18 driving→tube)", () => {
		t = 0;
		const day = [
			st("walking"),
			st("driving", { wayName: "Deepwell Underpass" }),
			st("train", { wayName: "Deepwell → Ashvale · Metropolitan Line" }),
			st("walking"),
		];
		const v = checkDayConstraints(day);
		expect(v).toHaveLength(1);
		expect(v[0].constraint).toBe("vehicle-handoff");
		expect(v[0].index).toBe(1);
	});

	it("does NOT flag a train→train interchange (same mode, different line)", () => {
		t = 0;
		const day = [
			st("train", { wayName: "A → B · Jubilee Line" }),
			st("train", { wayName: "B → C · Metropolitan Line" }),
		];
		expect(checkDayConstraints(day)).toEqual([]);
	});

	it("flags a teleport between two distinct at-rest places", () => {
		t = 0;
		const day = [st("stationary", { place: "Work" }), st("stationary", { place: "Home" })];
		const v = checkDayConstraints(day);
		expect(v).toHaveLength(1);
		expect(v[0].constraint).toBe("stay-teleport");
	});

	it("flags a transit leg that boards and alights at the same station", () => {
		t = 0;
		const day = [st("train", { wayName: "Carfax → Carfax · Circle Line" })];
		const v = checkDayConstraints(day);
		expect(v).toHaveLength(1);
		expect(v[0].constraint).toBe("transit-same-endpoint");
	});

	it("does NOT flag two distinct stays separated by an unobserved gap (honest hole, not a teleport)", () => {
		// 2026-05-22 / 04-30 shape: a stay ends, then hours later a stay at a
		// different place begins — the travel happened in the unobserved gap.
		const a: DayState = { startTs: 0, endTs: 3600, mode: "stationary", place: "Royal Free Hospital" };
		const b: DayState = { startTs: 3600 + 2 * 3600, endTs: 3600 + 3 * 3600, mode: "sleeping", place: "Home" };
		expect(checkDayConstraints([a, b])).toEqual([]);
	});

	it("does NOT flag a vehicle→vehicle change across a gap (alighting happened in the gap)", () => {
		const a: DayState = { startTs: 0, endTs: 600, mode: "driving" };
		const b: DayState = { startTs: 600 + 600, endTs: 600 + 1200, mode: "train", wayName: "X → Y · L" };
		expect(checkDayConstraints([a, b])).toEqual([]);
	});

	it("allows a vehicle bracketed by walking on both sides", () => {
		t = 0;
		const day = [st("walking"), st("bus", { wayName: "Stop A → Stop B · 38" }), st("walking"), st("driving")];
		// bus→walking→driving: the walking separates the two vehicles, so legal.
		expect(checkDayConstraints(day)).toEqual([]);
	});
});
