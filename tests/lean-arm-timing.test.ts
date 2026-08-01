/**
 * What the two arms cost, as the shadow ledgers report it.
 *
 * The soak could say "Lean agrees" for months without anyone knowing whether
 * serving it was affordable. These pin the accounting, and in particular the
 * decisions that are easy to get backwards: a thrown call still counts (it is
 * the most expensive one there is), a tenant that never called the bridge
 * prints nothing rather than a zero, and the RATIO — the number a flip turns
 * on — is only quoted when both arms were measured over the same calls.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type ArmTiming,
	armPair,
	formatArmPair,
	freshArmTiming,
	recordArmMs,
	resetArmPair,
	timeArm,
	timeLeanArm,
	timeTsArm,
} from "../src/lean/arm-timing.js";

const of = (...ms: number[]): ArmTiming => {
	const t = freshArmTiming();
	for (const m of ms) recordArmMs(t, m);
	return t;
};

const pair = (ts: ArmTiming, lean: ArmTiming) => ({ ts, lean });

describe("recordArmMs", () => {
	it("accumulates calls, total and max", () => {
		expect(of(3, 1, 9, 2)).toEqual({ calls: 4, totalMs: 15, maxMs: 9 });
	});

	it("starts at zero, not at the first call's value", () => {
		expect(freshArmTiming()).toEqual({ calls: 0, totalMs: 0, maxMs: 0 });
	});
});

describe("formatArmPair", () => {
	it("reports both arms, the ratio, and the tail", () => {
		const s = formatArmPair(pair(of(10, 10, 10), of(10, 20, 300)));
		expect(s).toContain("3 calls");
		expect(s).toContain("ts 30ms");
		expect(s).toContain("lean 330ms");
		// The whole point of the instrument: 330/30. "lean costs 330ms" alone
		// cannot answer "is Lean much slower than TS", which is the actual bar.
		expect(s).toContain("11.0×");
		expect(s).toContain("lean avg 110ms");
		// The tail is not decoration: `LEAN_CALL_TIMEOUT_MS` is enforced per call,
		// so the mean of 110 ms is the reassuring number and the 300 ms is the one
		// that decides whether a flip is safe.
		expect(s).toContain("max 300ms");
	});

	// Lean winning is a real outcome, not a formatting edge case — the stated
	// goal is for the verified core to get FASTER than TS, so the line has to be
	// able to say so.
	it("reports a sub-1× ratio when Lean is the faster arm", () => {
		expect(formatArmPair(pair(of(100), of(25)))).toContain("0.3×");
	});

	// A TS arm too fast to measure would make the ratio infinite. An unreadable
	// number is worse than an admission.
	it("refuses to quote a ratio against an unmeasurable TS arm", () => {
		const s = formatArmPair(pair(of(0), of(5)));
		expect(s).toContain("ratio n/a");
		expect(s).not.toContain("Infinity");
	});

	// A tenant that never reached the bridge must not print a cost line at all.
	// `arm 0 calls` reads as "free", when what happened is "did not run" — and
	// `not-exercised` is already the loud way to say that.
	it("says nothing when nothing was timed", () => {
		expect(formatArmPair(pair(freshArmTiming(), freshArmTiming()))).toBe("");
	});

	// Equal counts are the invariant the wrappers maintain, not an assumption
	// this formatter is entitled to make. If they ever diverge the reader must
	// see it rather than read a plausible ratio over mismatched sets.
	it("prints both counts when the arms disagree about how many calls there were", () => {
		expect(formatArmPair(pair(of(1, 1), of(1)))).toContain("ts 2 / lean 1 calls");
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

describe("the per-tenant registry", () => {
	beforeEach(() => {
		resetArmPair("probe");
		resetArmPair("other");
	});

	it("keeps the two arms of one tenant apart", () => {
		timeTsArm("probe", () => 1);
		timeLeanArm("probe", () => 2);
		timeLeanArm("probe", () => 3);
		expect(armPair("probe").ts.calls).toBe(1);
		expect(armPair("probe").lean.calls).toBe(2);
	});

	it("keeps tenants apart", () => {
		timeLeanArm("probe", () => 1);
		expect(armPair("other").lean.calls).toBe(0);
	});

	// The ledger resets its tenant after printing, so a per-day line reports that
	// day rather than everything since the process booted.
	it("resets one tenant without touching another", () => {
		timeLeanArm("probe", () => 1);
		timeLeanArm("other", () => 1);
		resetArmPair("probe");
		expect(armPair("probe").lean.calls).toBe(0);
		expect(armPair("other").lean.calls).toBe(1);
	});

	it("reads all-zero for a tenant that never ran", () => {
		expect(armPair("never-called")).toEqual({
			ts: { calls: 0, totalMs: 0, maxMs: 0 },
			lean: { calls: 0, totalMs: 0, maxMs: 0 },
		});
	});
});
