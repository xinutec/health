/**
 * What the Lean arm costs, as the shadow ledgers report it.
 *
 * The soak could say "Lean agrees" for months without anyone knowing whether
 * serving it was affordable. These pin the accounting, and in particular the
 * two decisions that are easy to get backwards: a thrown call still counts (it
 * is the most expensive one there is), and a tenant that never called the
 * bridge prints nothing rather than a zero.
 */

import { describe, expect, it } from "vitest";
import { type ArmTiming, formatArmTiming, freshArmTiming, recordArmMs, timeArm } from "../src/lean/arm-timing.js";

const of = (...ms: number[]): ArmTiming => {
	const t = freshArmTiming();
	for (const m of ms) recordArmMs(t, m);
	return t;
};

describe("recordArmMs", () => {
	it("accumulates calls, total and max", () => {
		expect(of(3, 1, 9, 2)).toEqual({ calls: 4, totalMs: 15, maxMs: 9 });
	});

	it("starts at zero, not at the first call's value", () => {
		expect(freshArmTiming()).toEqual({ calls: 0, totalMs: 0, maxMs: 0 });
	});
});

describe("formatArmTiming", () => {
	it("reports total, count, mean and the tail", () => {
		const s = formatArmTiming(of(10, 20, 300));
		expect(s).toContain("330ms/3");
		expect(s).toContain("avg 110.0ms");
		// The tail is the point: `LEAN_CALL_TIMEOUT_MS` is enforced per call, so
		// the mean of 110 ms is the reassuring number and the 300 ms is the one
		// that decides whether a flip is safe.
		expect(s).toContain("max 300ms");
	});

	// A tenant that never reached the bridge must not print a cost line at all.
	// `perf 0 calls` reads as "free", when what happened is "did not run" — and
	// `not-exercised` is already the loud way to say that.
	it("says nothing when nothing was timed", () => {
		expect(formatArmTiming(freshArmTiming())).toBe("");
	});
});

describe("timeArm", () => {
	it("returns the value and counts the call", () => {
		const t = freshArmTiming();
		expect(timeArm(t, () => 42)).toBe(42);
		expect(t.calls).toBe(1);
	});

	// The case that matters. A timed-out bridge call is the most expensive call
	// the tenant makes and the one a flip decision most needs to see; dropping it
	// would make the tail look best exactly when it is worst.
	it("counts a call that threw, and still propagates the throw", () => {
		const t = freshArmTiming();
		expect(() =>
			timeArm(t, (): number => {
				throw new Error("bridge timeout");
			}),
		).toThrow("bridge timeout");
		expect(t.calls).toBe(1);
		expect(t.maxMs).toBeGreaterThanOrEqual(0);
	});
});
