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
 * The first two were measured on the 31-day golden corpus (2026-07-20); the
 * third was observed by the production ledger on a day the corpus does not
 * cover (see its reason). All are single-vertex Douglas-Peucker near-ties on
 * the coarse-path simplify pass: the retained vertex moves, and the dropped
 * one stays within tolerance of the chord either way — `simplifyIdx_dropped_le`
 * (lean/Verified/Geo/Simplify.lean) proves that bound holds for whichever
 * vertex the served side keeps.
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
	{
		op: "simplify",
		n: 115,
		note: "ts-only=[64] lean-only=[62]",
		reason:
			"DP argmax tie on segment (50,68), tol 5 m: float separates idx 62 (7.056392500 m) from idx 64 " +
			"(7.060161943 m) by 3.77 mm, but both quantise to exactly 7063019 µm, so first-argmax takes 62. " +
			"The gap is under the 1e-7° representation's ~3-7 mm resolving power — the served metric cannot " +
			"order these two points. Both deviations far exceed tol, so both sides split and keep 47 vertices; " +
			"only which vertex anchors the split differs. Observed by the production ledger on 2026-07-17 " +
			"(outside the golden corpus, which ends 2026-07-16); reproduced read-only via decode-day --dry. " +
			"It arises in the extra velocity run `runWalkShadow` does to extract legs, not in the decode run " +
			"whose output is persisted — that run is 8/8 exact on this day.",
	},
];

const key = (op: string, n: number, note: string): string => `${op}|${n}|${note}`;
const acceptedKeys = new Set(ACCEPTED_DELTAS.map((d) => key(d.op, d.n, d.note)));

/** True iff this measured divergence is in the accepted near-tie manifest. */
export function isAcceptedDelta(op: string, n: number, note: string): boolean {
	return acceptedKeys.has(key(op, n, note));
}

/** A divergence as the ledger measures it, before adjudication. */
export interface MeasuredDelta {
	op: string;
	n: number;
	note: string;
}

/**
 * The ones that are NOT signed off — the flip's premise is that this is empty.
 *
 * Both the `shadow-passes` gate and the production decode ledger adjudicate
 * through here, so the corpus gate and the live soak cannot drift into
 * disagreeing about what counts as explained.
 */
export function unexplainedDeltas(divs: readonly MeasuredDelta[]): readonly MeasuredDelta[] {
	return divs.filter((d) => !isAcceptedDelta(d.op, d.n, d.note));
}

/** Per-divergence label, shared so the gate and the ledger read alike. */
export function deltaTag(d: MeasuredDelta): "accepted" | "UNEXPLAINED" {
	return isAcceptedDelta(d.op, d.n, d.note) ? "accepted" : "UNEXPLAINED";
}
