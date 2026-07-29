/**
 * The Lean bridge's exact-Float transport (`src/lean/float-bits.ts`).
 *
 * These run in CI without the Lean binary, so they pin the TS half of the
 * contract only: whatever a Float is, `floatToBits` → `floatFromBits` must
 * return it unchanged. The Lean half (`fBits` / `jBits` in `lean/Main.lean`) is
 * pinned by `compare-kalman`, which confirmed all 860 of a real day's latitudes
 * survive the round trip through `verified_cli` bit-identical.
 *
 * The cases below are the ones that motivated bit transport in the first place:
 * a full-precision coordinate, a value the six-decimal JSON printer flattens to
 * zero, and the signed zero / non-finite patterns a numeric comparison would
 * quietly conflate.
 */
import { describe, expect, it } from "vitest";
import { floatFromBits, floatToBits } from "../src/lean/float-bits.js";

const roundTrips = (v: number): number => floatFromBits(floatToBits(v));

describe("float-bits", () => {
	it("round-trips full-precision coordinates", () => {
		// Real filtered output from 2026-05-15 — the values Lean's JSON printer
		// truncated to 51.500099 / -0.100092 before bit transport.
		for (const v of [51.50009905063291, -0.10009182429544923, 4.717694629017221, 328.1536087263755]) {
			expect(roundTrips(v)).toBe(v);
		}
	});

	it("round-trips values the decimal printer loses entirely", () => {
		expect(roundTrips(1e-7)).toBe(1e-7);
		expect(roundTrips(5e-324)).toBe(5e-324); // smallest subnormal
		expect(roundTrips(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
	});

	it("preserves the sign of zero", () => {
		// `-0 === 0`, so `toBe` would pass on a lost sign; `Object.is` would not.
		expect(Object.is(roundTrips(-0), -0)).toBe(true);
		expect(Object.is(roundTrips(0), 0)).toBe(true);
		expect(floatToBits(-0)).not.toBe(floatToBits(0));
	});

	it("round-trips the non-finite patterns", () => {
		expect(roundTrips(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
		expect(roundTrips(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
		expect(Number.isNaN(roundTrips(Number.NaN))).toBe(true);
	});

	it("round-trips the extremes and a spread of magnitudes", () => {
		for (const v of [Number.MAX_VALUE, -Number.MAX_VALUE, 1, -1, 1e300, 1e-300, Math.PI, 2 ** 53 + 2]) {
			expect(roundTrips(v)).toBe(v);
		}
	});

	it("emits a decimal string, never a JS number", () => {
		// The whole point: 2^63 exceeds the 2^53 JS integers are exact to, so the
		// pattern must not travel as a JSON number. Guard the shape.
		const bits = floatToBits(-0);
		expect(bits).toBe("9223372036854775808");
		expect(Number(bits)).not.toBe(9223372036854775808n as unknown as number);
		expect(BigInt(bits)).toBe(2n ** 63n);
	});
});
