/**
 * Exact Float transport for the Lean bridge.
 *
 * Every other bridge mode quantises its coordinates to the pinned 1e-7° integer
 * grid, so it never needs this. The Kalman filter does: it is a covariance
 * recursion over raw degrees where the seventh decimal of a fix moves the gain,
 * and the golden corpus compares byte-exact output, so its inputs and outputs
 * have to cross the wire unrounded.
 *
 * JSON cannot carry a Float unrounded in either direction. Lean's printer emits
 * six decimal places (`Lean.JsonNumber` is a decimal mantissa and Lean has no
 * shortest-round-trip printer), and JS `JSON.parse` re-rounds anything past 2^53.
 * So the value travels as its IEEE-754 bit pattern, written as a decimal STRING
 * — a bare JSON integer would hit exactly the 2^53 limit one layer down.
 *
 * Exact by construction for every Float, including subnormals, `-0`, and the
 * non-finite patterns. The Lean twin is `fBits` / `jBits` in `lean/Main.lean`.
 */

const view = new DataView(new ArrayBuffer(8));

/** A Float's IEEE-754 bit pattern as an unsigned decimal string. */
export function floatToBits(v: number): string {
	view.setFloat64(0, v);
	return view.getBigUint64(0).toString();
}

/** Inverse of `floatToBits`. Throws on a string that is not a bit pattern. */
export function floatFromBits(s: string): number {
	view.setBigUint64(0, BigInt(s));
	return view.getFloat64(0);
}
