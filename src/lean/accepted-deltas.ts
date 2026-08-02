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
 * ## What an entry is keyed on, and why it changed (#409)
 *
 * Entries were keyed on `op | n | note` — the op, the pass INPUT LENGTH, and
 * the exact flipped indices. That is a fingerprint of the path handed to the
 * pass, not of the thing the sign-off is about, and it fails in both
 * directions:
 *
 *  - It moves when nothing has changed. #406 altered the matcher's candidate
 *    cut, which lengthened two matched paths by one vertex. `n` went 1235→1236
 *    and another leg's indices all shifted by one; two signed-off near-ties
 *    stopped matching their keys and the deploy gate reported them as new. The
 *    near-ties were identical. Re-keying them by hand cost a full corpus
 *    bisect to establish that, and could only conclude "same leg" by inference,
 *    because nothing recorded which leg it was.
 *  - It collides. Two different legs can share an input length and a flip
 *    position, and a genuinely new divergence landing on an existing key would
 *    have been accepted in silence. That is the failure a manifest exists to
 *    prevent.
 *
 * So an entry now names a LEG and bounds a SHAPE:
 *
 *  - `leg` is `legFingerprint` (`leg-compare.ts`) — a digest of the leg's own
 *    quantised GPS fixes. The matcher may redraw the path however it likes; the
 *    fixes it was handed are the same fixes, so the key survives exactly the
 *    changes that used to break it. It is the same key `accepted-match-deltas.ts`
 *    uses, so both manifests now name a leg the same way, and it keeps raw
 *    positions out of a committed file.
 *  - `maxFlips` / `maxShift` bound what may differ: at most this many vertices,
 *    each moving at most this far in index. A single-vertex DP near-tie moves
 *    one vertex by one. Anything structurally larger — a vertex genuinely
 *    added or dropped rather than swapped, or a flip that jumps — is NOT what
 *    was signed off and fails, on the same leg as before.
 *
 * The pair is what makes this safe: the leg is stable but coarse, the shape
 * bound is strict but position-independent. Keying on the leg alone would
 * accept any future divergence on a leg once excused.
 *
 * A divergence with NO leg (`leg: ""`) is never accepted. Those arise where a
 * pass runs outside any matcher leg — the episode-geometry `spikes` calls,
 * which operate on fix windows — and an unattributable divergence must not be
 * matchable by a manifest entry that names a leg.
 */

/** A divergence as the ledger measures it, before adjudication. */
export interface MeasuredDelta {
	op: string;
	/** Pass input length. Reported, never keyed on — it moves whenever anything
	 *  upstream adds or drops a vertex, which is the defect #409 fixed. */
	n: number;
	note: string;
	/** `legFingerprint` of the leg, or `""` when the pass ran outside one. */
	leg: string;
	/** The flip, structurally — absent for the count-only ops. */
	tsOnly?: readonly number[];
	leanOnly?: readonly number[];
}

export interface AcceptedDelta {
	op: string;
	/** `legFingerprint` of the leg's raw fixes — stable across path changes. */
	leg: string;
	/** How many vertices may differ between the arms. */
	maxFlips: number;
	/** How far, in indices, a differing vertex may move. */
	maxShift: number;
	/** Why this near-tie is accepted (human sign-off, for the audit trail). */
	reason: string;
}

/**
 * Measured on the 32-day golden corpus. Both are single-vertex Douglas-Peucker
 * near-ties on the coarse-path simplify pass: the retained vertex moves, and
 * the dropped one stays within tolerance of the chord either way —
 * `simplifyIdx_dropped_le` (lean/Verified/Geo/Simplify.lean) proves that bound
 * holds for whichever vertex the served side keeps.
 *
 * Two entries the old `op|n|note` keying carried are gone, and neither is a
 * silent drop:
 *
 *  - `simplify/72/ts-only=[18] lean-only=[17]` was never in this manifest — it
 *    sits in the delta CEILING (`tests/golden/lean-delta-baseline.json`) as
 *    un-adjudicated debt, and stays there. Debt and judgement must not merge.
 *  - `simplify/115/ts-only=[64] lean-only=[62]` documented the 1e-7° grid's
 *    ~3-7 mm resolving power: float separated idx 62 from idx 64 by 3.77 mm,
 *    but both quantised to exactly 7063019 µm, so first-argmax took 62. It has
 *    NOT been reproduced since 2026-07-22, when the walk shadow stopped
 *    replaying a reconstructed leg set the matcher never actually matched. An
 *    entry that cannot be observed cannot be re-keyed to a leg, and keeping a
 *    guessed key would be worse than dropping it: the measurement is recorded
 *    here in prose, and if it ever recurs it will present as a new divergence
 *    and be adjudicated on its own evidence rather than waved through.
 */
export const ACCEPTED_DELTAS: readonly AcceptedDelta[] = [
	{
		op: "simplify",
		leg: "826293a6a487b312",
		maxFlips: 2,
		maxShift: 1,
		reason:
			"DP near-tie: two adjacent-vertex flips, each within simplify tol; display-only, washes out of golden. " +
			"Carried over from the `op|n|note` key `simplify/1235/ts-only=[484,619] lean-only=[485,618]`, which #406 " +
			"moved to n=1236 by lengthening this path one vertex. The leg is measured, not inferred: the harvest run " +
			"attributes this divergence to a road-profile leg, which is also why the first attempt at #409 left it " +
			"unattributed — it never passes through the walk wrapper.",
	},
	{
		op: "simplify",
		leg: "cb4c37b088555857",
		maxFlips: 2,
		maxShift: 1,
		reason:
			"DP near-tie: two adjacent-vertex flips, each within simplify tol; display-only, washes out of golden. " +
			"Carried over from `simplify/985/ts-only=[653,947] lean-only=[652,946]`, whose indices #406 shifted by " +
			"one while `n` stayed put. Also a road-profile leg.",
	},
];

const acceptedByLeg = new Map<string, AcceptedDelta[]>();
for (const d of ACCEPTED_DELTAS) {
	const list = acceptedByLeg.get(d.leg);
	if (list === undefined) acceptedByLeg.set(d.leg, [d]);
	else list.push(d);
}

/**
 * Does this divergence's shape sit inside what the entry signed off?
 *
 * A near-tie is a SWAP: each arm keeps a different vertex from the same
 * neighbourhood, so the two symmetric-difference lists have equal length and
 * pair up in order. Unequal lengths mean a vertex was genuinely added or
 * dropped, which is a different phenomenon and not what any entry here
 * describes — reject it even on a signed-off leg.
 */
export function shapeWithin(d: MeasuredDelta, a: AcceptedDelta): boolean {
	const { tsOnly, leanOnly } = d;
	// An op that reports no index sets (the count-only passes) cannot be
	// shape-checked, so it cannot be accepted by this rule at all.
	if (tsOnly === undefined || leanOnly === undefined) return false;
	if (tsOnly.length !== leanOnly.length) return false;
	if (tsOnly.length === 0 || tsOnly.length > a.maxFlips) return false;
	return tsOnly.every((i, k) => Math.abs(i - leanOnly[k]) <= a.maxShift);
}

/** True iff this measured divergence is in the accepted near-tie manifest. */
export function isAcceptedDelta(d: MeasuredDelta): boolean {
	if (d.leg === "") return false;
	const candidates = acceptedByLeg.get(d.leg);
	if (candidates === undefined) return false;
	return candidates.some((a) => a.op === d.op && shapeWithin(d, a));
}

/**
 * The ones that are NOT signed off — the flip's premise is that this is empty.
 *
 * Both the `shadow-passes` gate and the production decode ledger adjudicate
 * through here, so the corpus gate and the live soak cannot drift into
 * disagreeing about what counts as explained.
 */
export function unexplainedDeltas(divs: readonly MeasuredDelta[]): readonly MeasuredDelta[] {
	return divs.filter((d) => !isAcceptedDelta(d));
}

/** Per-divergence label, shared so the gate and the ledger read alike. */
export function deltaTag(d: MeasuredDelta): "accepted" | "UNEXPLAINED" {
	return isAcceptedDelta(d) ? "accepted" : "UNEXPLAINED";
}

/**
 * The stable fingerprint a divergence is reported and ceilinged by.
 *
 * Leg-first, because that is the part that survives an upstream redraw; the
 * shape follows so a ceiling entry still says what it is tolerating. `n` is
 * deliberately absent — it was the volatile half of the old key.
 */
export function deltaFingerprint(d: MeasuredDelta): string {
	const leg = d.leg === "" ? "unattributed" : d.leg;
	const shape =
		d.tsOnly === undefined || d.leanOnly === undefined
			? d.note
			: `flips=${d.tsOnly.length} shift=${maxShiftOf(d.tsOnly, d.leanOnly)}`;
	return `${d.op}/${leg}/${shape}`;
}

function maxShiftOf(tsOnly: readonly number[], leanOnly: readonly number[]): number | "n/a" {
	if (tsOnly.length !== leanOnly.length || tsOnly.length === 0) return "n/a";
	return tsOnly.reduce((m, i, k) => Math.max(m, Math.abs(i - leanOnly[k])), 0);
}
