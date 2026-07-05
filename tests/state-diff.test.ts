/**
 * state-diff — shared primitives for rendering and diffing the
 * non-overlapping day-state sequence the timeline shows. Used by
 * golden-check (expected vs actual) and by backtest-classification
 * (legacy cascade vs factor scorer).
 */

import { describe, expect, it } from "vitest";
import { diffStates, normalizeStates, stateLine } from "../src/cli/state-diff.js";
import type { DayState } from "../src/sleep/day-state.js";

/** A 06:00-07:00 UTC stay built minimally for the tests. */
function stay(startTs: number, endTs: number, overrides: Partial<DayState> = {}): DayState {
	return { startTs, endTs, mode: "stationary", ...overrides };
}

const H = 3600;
const T = (h: number, m = 0) => h * H + m * 60; // seconds-from-epoch shorthand

describe("normalizeStates", () => {
	it("returns an empty list for empty input", () => {
		expect(normalizeStates([], "UTC")).toEqual([]);
	});

	it("formats a stationary state with place as `@ <place>`", () => {
		const out = normalizeStates([stay(T(9), T(10), { place: "Home" })], "UTC");
		expect(out).toEqual([{ from: "09:00", to: "10:00", mode: "stationary", label: "@ Home", asleep: false }]);
	});

	it("formats a moving state with wayName as `on <way>`", () => {
		const out = normalizeStates([{ startTs: T(8), endTs: T(8, 30), mode: "train", wayName: "A → B" }], "UTC");
		expect(out).toEqual([{ from: "08:00", to: "08:30", mode: "train", label: "on A → B", asleep: false }]);
	});

	it("renders an empty label when there's no place and no wayName", () => {
		const out = normalizeStates([{ startTs: T(12), endTs: T(12, 15), mode: "walking" }], "UTC");
		expect(out).toEqual([{ from: "12:00", to: "12:15", mode: "walking", label: "", asleep: false }]);
	});

	it("preserves the asleep flag", () => {
		const out = normalizeStates([{ startTs: T(7), endTs: T(8), mode: "train", wayName: "A → B", asleep: true }], "UTC");
		expect(out[0].asleep).toBe(true);
	});

	it("treats absent asleep as false (not undefined)", () => {
		const out = normalizeStates([stay(T(9), T(10), { place: "Home" })], "UTC");
		expect(out[0].asleep).toBe(false);
	});

	it("renders wall-clock times in the requested timezone", () => {
		// 09:00 UTC == 10:00 Europe/London in BST (May). Use a real BST
		// date so the tz really shifts the output.
		const may22 = Date.UTC(2026, 4, 22, 9, 0, 0) / 1000;
		const may22End = Date.UTC(2026, 4, 22, 10, 0, 0) / 1000;
		const out = normalizeStates([stay(may22, may22End, { place: "Home" })], "Europe/London");
		expect(out[0].from).toBe("10:00");
		expect(out[0].to).toBe("11:00");
	});
});

describe("stateLine", () => {
	it("renders a stationary state with a place", () => {
		expect(stateLine({ from: "09:00", to: "10:00", mode: "stationary", label: "@ Home", asleep: false })).toBe(
			"09:00-10:00  stationary  @ Home",
		);
	});

	it("renders a moving state on a way", () => {
		// "train" (5) padEnd(11) gives 6 trailing spaces; the label
		// prefix adds one → 7 spaces between "train" and "on".
		expect(stateLine({ from: "13:16", to: "13:26", mode: "train", label: "on A → B", asleep: false })).toBe(
			"13:16-13:26  train       on A → B",
		);
	});

	it("renders an asleep tag inside a moving state (sleeping on a train)", () => {
		expect(stateLine({ from: "23:00", to: "06:00", mode: "train", label: "on A → B", asleep: true })).toBe(
			"23:00-06:00  train       (asleep) on A → B",
		);
	});

	it("renders a state with no label", () => {
		expect(stateLine({ from: "12:00", to: "12:15", mode: "walking", label: "", asleep: false })).toBe(
			"12:00-12:15  walking    ",
		);
	});
});

describe("diffStates", () => {
	const a = { from: "09:00", to: "10:00", mode: "stationary", label: "@ Home", asleep: false };
	const b = { from: "10:00", to: "11:00", mode: "walking", label: "", asleep: false };
	const c = { from: "11:00", to: "12:00", mode: "stationary", label: "@ Work", asleep: false };

	it("reports identical=true when both lists match exactly", () => {
		const r = diffStates([a, b], [a, b]);
		expect(r.identical).toBe(true);
		expect(r.lines).toHaveLength(2);
		expect(r.lines.every((l) => l.startsWith("    ok"))).toBe(true);
	});

	it("flags a single-row replacement as - / +", () => {
		const aPrime = { ...a, label: "@ Hostel" };
		const r = diffStates([a, b], [aPrime, b]);
		expect(r.identical).toBe(false);
		expect(r.lines).toEqual([
			expect.stringMatching(/^ {4}- {4}.*@ Home/),
			expect.stringMatching(/^ {4}\+ {4}.*@ Hostel/),
			expect.stringMatching(/^ {4}ok/),
		]);
	});

	it("flags an insertion in the right-hand list as +", () => {
		const r = diffStates([a, c], [a, b, c]);
		expect(r.identical).toBe(false);
		// Index 1 differs (b vs c); index 2 has no left (just +).
		expect(r.lines[0]).toMatch(/^ {4}ok/);
		expect(r.lines[1]).toMatch(/^ {4}- {4}.*@ Work/);
		expect(r.lines[2]).toMatch(/^ {4}\+ {4}.*walking/);
		expect(r.lines[3]).toMatch(/^ {4}\+ {4}.*@ Work/);
	});

	it("flags a deletion in the right-hand list as -", () => {
		// Index-aligned diff (not LCS): at index 1 sees `b` vs `c` →
		// emit -b / +c; at index 2 sees `c` vs nothing → emit -c.
		const r = diffStates([a, b, c], [a, c]);
		expect(r.identical).toBe(false);
		expect(r.lines[0]).toMatch(/^ {4}ok/);
		expect(r.lines[1]).toMatch(/^ {4}- {4}.*walking/);
		expect(r.lines[2]).toMatch(/^ {4}\+ {4}.*@ Work/);
		expect(r.lines[3]).toMatch(/^ {4}- {4}.*@ Work/);
	});

	it("identical=true requires identical lengths too", () => {
		// Prefix matches but b has an extra entry: not identical.
		const r = diffStates([a], [a, b]);
		expect(r.identical).toBe(false);
	});
});
