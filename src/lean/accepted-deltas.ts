/**
 * The accepted near-tie delta manifest for the verified geometry passes.
 *
 * When `LEAN_PASSES=on` serves the verified Lean geometry, it adopts the
 * quantised (1e-7° integer) arithmetic as truth. On a handful of golden legs
 * that differs from the TS float arithmetic by a single vertex — a
 * Douglas-Peucker near-tie, where two adjacent points are almost exactly
 * equidistant from the spanning chord and float-vs-quant rounding picks the
 * other one. These are display-only (the drawn polyline shifts by one vertex,
 * well within the simplify tolerance) and provably within bound; they wash out
 * of the final golden output entirely (golden is 31/31 byte-identical under
 * `on`).
 *
 * This manifest is the *closed set* of such divergences we have inspected and
 * accept. The flip gate (`shadow-passes`) asserts that the measured divergence
 * set is a subset of this manifest: any NEW or unexplained divergence — a
 * different leg, a different op, a multi-vertex change — fails the gate. That
 * is the honest boundary between "known, bounded near-tie" and "a real
 * behaviour change we have not signed off".
 *
 * Each entry is keyed by `op` + input length `n` + the exact symmetric-
 * difference note the ledger emits, so a match is an exact fingerprint of the
 * divergence, not a fuzzy "some leg of this size".
 */

export interface AcceptedDelta {
	op: string;
	/** Input point count of the diverging leg. */
	n: number;
	/** The exact `ts-only=[…] lean-only=[…]` note `leanPassDivergences` emits. */
	note: string;
	/** Why this near-tie is accepted (human sign-off, for the audit trail). */
	reason: string;
}

/**
 * Measured on the 31-day golden corpus (2026-07-20). Both are single-vertex
 * Douglas-Peucker near-ties on the coarse-path simplify pass: the retained
 * vertex moves by one index, the dropped one stays within tolerance of the
 * chord either way.
 */
export const ACCEPTED_DELTAS: readonly AcceptedDelta[] = [
	{
		op: "simplify",
		n: 1235,
		note: "ts-only=[484,619] lean-only=[485,618]",
		reason: "DP near-tie: two adjacent-vertex flips, each within simplify tol; display-only, washes out of golden.",
	},
	{
		op: "simplify",
		n: 985,
		note: "ts-only=[653,947] lean-only=[652,946]",
		reason: "DP near-tie: two adjacent-vertex flips, each within simplify tol; display-only, washes out of golden.",
	},
];

const key = (op: string, n: number, note: string): string => `${op}|${n}|${note}`;
const acceptedKeys = new Set(ACCEPTED_DELTAS.map((d) => key(d.op, d.n, d.note)));

/** True iff this measured divergence is in the accepted near-tie manifest. */
export function isAcceptedDelta(op: string, n: number, note: string): boolean {
	return acceptedKeys.has(key(op, n, note));
}
