/**
 * How far apart are two Floats that came back from the bridge?
 *
 * The Kalman ledger needs a magnitude, not just a yes/no: `lat`/`lon`/`speed`
 * diverge by a bit or two on ~0.5% of rows because Lean's `Float.cos` and V8's
 * `Math.cos` disagree by 1 ULP on 7.6% of real latitudes, and that class is
 * expected. Distinguishing it from a real defect means measuring the gap. Both
 * measurements below were got wrong first, in ways worth keeping written down —
 * a wrong distance is worse than no distance, because it reads as authoritative.
 *
 * Companion to `float-bits.ts`: that one carries Floats across the wire, this
 * one compares the two sides once they are back.
 */

import { floatFromBits } from "./float-bits.js";

/**
 * Bit pattern → an integer that ORDERS like the float it encodes.
 *
 * IEEE doubles compare correctly as raw integers only within one sign; the
 * negatives run backwards. Within a sign — which is every comparison the ledger
 * has actually made — this changes nothing, so it is a correctness measure
 * rather than a rescue: it makes a cross-zero gap the true count of doubles
 * between the two values instead of an arbitrary one.
 *
 * Worth knowing before reading such a gap: a cross-zero ULP distance is huge by
 * nature, not by defect. There are ~8.9e18 representable doubles between -1e-9
 * and +1e-9, because doubles crowd towards zero. ULP is the wrong unit for
 * "how far apart physically" once two values straddle the origin; it is the
 * right unit for the libm-wobble class this ledger grades, which never does.
 */
function ordinal(bits: string): bigint {
	const b = BigInt(bits);
	return b & 0x8000000000000000n ? 0x8000000000000000n - b : b;
}

/**
 * ULP distance between two Floats given as bit patterns: how many representable
 * doubles lie between them.
 *
 * A numeric distance, so `-0` and `+0` are 0 apart — they are the same number.
 * The ledger still notices the difference, because it compares rows by bit
 * pattern first and only then asks this for a magnitude; a representation-only
 * difference correctly scores zero.
 *
 * Returns `bigint` deliberately, for two distinct reasons. A gap past 2^53 may
 * not be representable as a double at all; and even one that IS gets printed as
 * the shortest decimal that round-trips, so the real 4645040803167600640 first
 * reached the log as ...601000 — near enough to look like a measurement, wrong
 * enough that checking it is what exposed the bearing bug.
 */
export function ulpGap(aBits: string, bBits: string): bigint {
	const x = ordinal(aBits);
	const y = ordinal(bBits);
	return x > y ? x - y : y - x;
}

/**
 * Angular difference in degrees, the short way round the circle.
 *
 * `bearing` is modular, so its bit distance measures nothing: 0° and 360° are
 * the same heading and 4.6e18 ULPs apart. Measured in the first real in-cluster
 * soak (2026-07-29), where exactly that pair fired the ledger's loudest verdict
 * for two arms that agreed on the direction precisely.
 *
 * Non-finite inputs have no angle: two `NaN`s are equal here (matching the ULP
 * reading of identical patterns), and anything else involving one is infinitely
 * far, because a heading that stopped being a number IS the finding.
 */
export function circularDegGap(aBits: string, bBits: string): number {
	const a = floatFromBits(aBits);
	const b = floatFromBits(bBits);
	if (!Number.isFinite(a) || !Number.isFinite(b)) {
		return Number.isNaN(a) && Number.isNaN(b) ? 0 : Number.POSITIVE_INFINITY;
	}
	const d = Math.abs(a - b) % 360;
	return Math.min(d, 360 - d);
}
