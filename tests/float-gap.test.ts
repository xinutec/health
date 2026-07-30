import { describe, expect, it } from "vitest";
import { floatToBits } from "../src/lean/float-bits.js";
import { circularDegGap, ulpGap } from "../src/lean/float-gap.js";

const bits = floatToBits;
/** The next representable double above `v`, so a test can say "1 ULP" honestly
 *  instead of guessing a decimal that happens to be adjacent. */
function nextUp(v: number): number {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, v);
	view.setBigUint64(0, view.getBigUint64(0) + 1n);
	return view.getFloat64(0);
}

describe("ulpGap", () => {
	it("is zero for identical patterns and one for adjacent doubles", () => {
		expect(ulpGap(bits(51.5), bits(51.5))).toBe(0n);
		expect(ulpGap(bits(51.5), bits(nextUp(51.5)))).toBe(1n);
	});

	it("is symmetric", () => {
		expect(ulpGap(bits(1), bits(2))).toBe(ulpGap(bits(2), bits(1)));
	});

	// Negative bit patterns run backwards, so the ordering has to be repaired
	// before subtracting. Within a sign that repair is a no-op, which is why it
	// changes nothing about the gaps this ledger has actually reported.
	it("counts a same-sign gap the same either side of zero", () => {
		expect(ulpGap(bits(-51.5), bits(-nextUp(51.5)))).toBe(1n);
		expect(ulpGap(bits(-1e-9), bits(0))).toBe(ulpGap(bits(0), bits(1e-9)));
	});

	// Not a defect to fix — a fact to know before reading such a number. Doubles
	// crowd towards zero, so two values either side of the origin really are
	// astronomically many representable doubles apart. ULP is simply the wrong
	// unit once a comparison straddles zero.
	it("reports a genuinely vast gap across zero, because that is the truth", () => {
		expect(ulpGap(bits(-1e-9), bits(1e-9))).toBeGreaterThan(2n ** 62n);
	});

	// A numeric distance: -0 and +0 are the same number. The ledger still flags
	// the row, because it compares bit patterns before asking for a magnitude.
	it("calls -0 and +0 zero apart", () => {
		expect(ulpGap(bits(-0), bits(0))).toBe(0n);
	});

	// Returning bigint is the point, though not for the reason first assumed.
	// THIS gap survives Number intact (it has enough trailing zero bits to be an
	// exactly representable double) — what it does not survive is being PRINTED:
	// JS emits the shortest decimal that round-trips, so the log said
	// 4645040803167601000. A bigint prints what it is.
	it("prints a gap wider than 2^53 exactly, where a number would not", () => {
		const gap = ulpGap(bits(360), bits(0));
		expect(gap.toString()).toBe("4645040803167600640");
		expect(String(Number(gap))).toBe("4645040803167601000");
	});

	// And a gap that Number genuinely cannot hold: an odd count past 2^53.
	it("keeps an odd gap past 2^53 exact, which a number rounds away", () => {
		const a = 2n ** 53n + 1n;
		const gap = ulpGap("0", a.toString());
		expect(gap).toBe(a);
		expect(BigInt(Number(gap))).not.toBe(gap);
	});
});

describe("circularDegGap", () => {
	// The bug this module exists to prevent, half two — the one that actually
	// fired DIVERGED in production on 2026-07-29.
	it("calls 0° and 360° the same heading", () => {
		expect(circularDegGap(bits(0), bits(360))).toBe(0);
		expect(circularDegGap(bits(359.9999), bits(0))).toBeCloseTo(0.0001, 9);
	});

	it("takes the short way round", () => {
		expect(circularDegGap(bits(350), bits(10))).toBeCloseTo(20, 9);
		expect(circularDegGap(bits(10), bits(350))).toBeCloseTo(20, 9);
	});

	it("never exceeds a half turn", () => {
		for (const [a, b] of [
			[0, 180],
			[0, 181],
			[90, 271],
			[45, 225],
		]) {
			expect(circularDegGap(bits(a), bits(b))).toBeLessThanOrEqual(180);
		}
	});

	it("still sees a real heading disagreement", () => {
		expect(circularDegGap(bits(90), bits(180))).toBeCloseTo(90, 9);
	});

	it("treats two NaNs as equal and a lone non-finite as infinitely far", () => {
		expect(circularDegGap(bits(Number.NaN), bits(Number.NaN))).toBe(0);
		expect(circularDegGap(bits(Number.NaN), bits(90))).toBe(Number.POSITIVE_INFINITY);
		expect(circularDegGap(bits(Number.POSITIVE_INFINITY), bits(90))).toBe(Number.POSITIVE_INFINITY);
	});
});
