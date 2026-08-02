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
 * of the final golden output entirely (golden is 32/32 byte-identical under
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
 *
 * THE FINGERPRINT MOVES WHEN ITS INPUT DOES, and that is a trap. `n` and the
 * indices describe the path handed to the pass, so any upstream change that
 * adds or drops a single vertex re-keys every signed-off divergence downstream
 * of it, and the gate reports them as brand new. #406 hit exactly this: the
 * tie-inclusive candidate cut lengthened two matched paths by a vertex and two
 * entries here went UNEXPLAINED without anything about the near-ties changing.
 *
 * Re-keying such an entry is NOT the manifest-widening `deploy.sh` forbids —
 * the set does not grow and no new phenomenon is signed off. But the two are
 * easy to confuse, so the bar for re-keying is: the op, the flip shape and the
 * count are unchanged, AND the bound is re-verified from the corpus rather than
 * assumed. Record the old key and what re-verified it in `reason`. Anything
 * else — a new leg, a new op, a multi-vertex change — is a new entry, and a new
 * entry needs a real adjudication, not a fingerprint update.
 *
 * The reason this costs an investigation each time is that the ledger records
 * only `(op, n, note)`, with no leg or day identity, so "is this the same leg?"
 * can only ever be inferred. See #409.
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
		n: 1236,
		note: "ts-only=[484,619] lean-only=[485,618]",
		reason:
			"DP near-tie: two adjacent-vertex flips, each within simplify tol; display-only, washes out of golden. " +
			"RE-KEYED at #406 from n=1235: the tie-inclusive candidate cut admits one more segment, so the matched " +
			"path this pass receives is one vertex longer. The flipped indices are UNCHANGED. Same-leg is an " +
			"inference — the ledger records no leg identity (see #409) — but the bound was re-verified directly: " +
			"all 32 golden days stay byte-identical under `on`.",
	},
	{
		op: "simplify",
		n: 985,
		note: "ts-only=[654,948] lean-only=[653,947]",
		reason:
			"DP near-tie: two adjacent-vertex flips, each within simplify tol; display-only, washes out of golden. " +
			"RE-KEYED at #406 from ts-only=[653,947] lean-only=[652,946]: `n` is unchanged but every index moved by " +
			"exactly one, so the path gained a vertex ahead of 653 and lost one past 947. Same-leg is an inference " +
			"(no leg identity in the ledger, #409); the bound was re-verified directly — 32/32 golden days stay " +
			"byte-identical under `on`.",
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
			"only which vertex anchors the split differs. Observed by the production ledger on 2026-07-17 and " +
			"reproduced read-only via decode-day --dry. " +
			"NO LONGER REPRODUCED as of 2026-07-22: it arose in the walk shadow's extra velocity run, and that " +
			"run used a RECONSTRUCTED leg set the matcher never actually matched (8 invented legs vs the 9 " +
			"production feeds). With the shadow now replaying production's own recorded legs, 2026-07-17 is " +
			"EXACT across all pass ops. The entry is kept because the measurement is real and documents the " +
			"representation's resolving power, but it is a divergence of the old harness, not of served " +
			"output — the decode run was already 8/8 exact on this day when it was first recorded. " +
			"(An earlier revision also called 2026-07-17 'outside the golden corpus, which ends 2026-07-16'. " +
			"That was wrong: the day had already been captured as a fixture.)",
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
