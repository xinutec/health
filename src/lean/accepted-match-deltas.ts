/**
 * The accepted float↔quant delta manifest for the verified walk MATCHER.
 *
 * The matcher analogue of `accepted-deltas.ts` (which covers the geometry
 * passes). When `LEAN_MATCH=on` serves the verified Lean matcher, production
 * adopts the quantised (1e-7° integer) arithmetic as truth. On a handful of
 * golden legs that differs from the TS float matcher, and this file is the
 * *closed set* of those divergences we have inspected and accept. The flip gate
 * (`compare-match --gate`) asserts the measured set is a subset of this
 * manifest: any new or unexplained divergence — a different leg, a different
 * class, a different vertex signature, or a LINE THAT MOVED FURTHER than the
 * entry was signed off at — fails. That is the honest boundary between "known,
 * bounded, signed-off" and "a real behaviour change we have not reviewed".
 *
 * Each entry is keyed by the leg's OWN fingerprint (`legFingerprint`: a digest
 * of its quantised input fixes) plus the coarse/path classes and the vertex
 * note. Keying on the leg itself means ONE rule — `isAcceptedMatchDelta` —
 * adjudicates both the gate (golden days) and the production ledger (live days
 * the corpus does not contain). `date` and `hhmm` are audit trail, not key.
 *
 * ── WHY THIS FILE WAS REBUILT FROM SCRATCH (#395, 2026-07-31) ───────────────
 *
 * The previous version accepted 14 of its 21 entries with the single word
 * "Display-only." and a vertex count. Two things were wrong with that.
 *
 * FIRST, the safety basis was overstated. It argued that the matcher's output
 * is `walkMatchedPath`, that no decision reads it, and therefore that "even a
 * coarse route-choice flip changes only the drawn pavement polyline for one
 * leg". The narrow claim is true and was re-confirmed on 2026-07-31 — a 7-day
 * production re-decode under the rolled-back flag produced byte-identical
 * `decoded_days` rows, so the matcher genuinely cannot reach mode, place or
 * journey. But the conclusion does not follow. `coarsePath` feeds
 * `matchImprovesDisplay` (`map-match-core.ts`), a keep/discard gate: it decides
 * whether a matched line is drawn AT ALL. On leg 71e5544efa614a06 (#398) a
 * coarse divergence pushed the quant arm's stray to 42.1 m, past the 40 m cap,
 * and production drew raw GPS through buildings instead of a matched pavement
 * line. "Display-only" was therefore not a bound on anything; it named the
 * output but not the size of the change.
 *
 * SECOND, and the reason "near-tie" could survive as a sign-off: NOTHING IN
 * THIS FILE WAS A MEASUREMENT. There was no number saying how far apart the two
 * lines actually were, so a 0.01 m collinear-vertex artefact and a 17 m route
 * flip carried the same words. Every entry now records the measured symmetric
 * polyline deviation (`polylineDeviationM`, #396) that `compare-match --gate`
 * prints, and no entry may exist without one.
 *
 * ── WHAT THE MEASUREMENT SHOWS ──────────────────────────────────────────────
 *
 * Re-derived 2026-07-31 over the 32-day corpus: 185 legs, quant↔Lean 185/185
 * bit-EXACT, 22 float↔quant deltas. The deviations fall into two populations
 * with nothing between them:
 *
 *   20 legs at 0.00–0.04 m — sub-decimetre. The same line, drawn by arithmetic
 *                            that rounds differently in the last place.
 *    2 legs at 14.37 m and 17.52 m — genuine route-choice flips.
 *
 * That gap is what makes the sub-decimetre class safely acceptable, and it is
 * an argument about MAGNITUDE, not about which field the output lands in. The
 * nearest decision threshold downstream is `WALK_NEEDS_MATCH_M` = 18 m of
 * off-road distance, with a `WALK_MATCH_MAX_STRAY_M` = 40 m stray cap. A line
 * that moves four centimetres is ~450× short of the tightest of those, so it
 * cannot change `matchImprovesDisplay`, cannot change whether a match is kept,
 * and cannot change anything downstream of that. THAT is the bound — a measured
 * distance against a named threshold — and it is what each sub-decimetre entry
 * below asserts with its own number.
 *
 * The two route flips get no such bound and are signed off individually, on
 * per-leg quality measurements, in their own reasons. Because those reasons are
 * about ONE corridor rather than about size, their figures are enforced as
 * equalities rather than ceilings — see `basis` below.
 *
 * ── WHAT THIS FILE STILL DOES NOT ESTABLISH ─────────────────────────────────
 *
 * Ground truth. For the two route flips, which corridor was actually walked is
 * unknown and unknowable from the data; the sign-off says the quantised cost
 * function shows no defect at these legs, not that it is right. And a manifest
 * cannot prove the absence of a leg it has never seen: 71e5544efa614a06 was
 * served in production for ten days before anyone looked at it, on a live day
 * the corpus does not contain. Coverage is bounded by the corpus, always.
 */

export type MatchLegClass = "EXACT" | "NEAR" | "DIFF";

export interface AcceptedMatchDelta {
	/** THE KEY: `legFingerprint` of the leg's quantised input fixes — its own
	 *  identity, independent of which day it fell on. */
	leg: string;
	/** Golden day (YYYY-MM-DD) the leg was measured on. Audit trail only. */
	date: string;
	/** Leg start, hh:mm UTC (as `compare-match` prints it). Documentation only. */
	hhmm: string;
	/** The coarse (decision-layer) float↔quant class. */
	coarse: MatchLegClass;
	/** The path (display-splice) float↔quant class. */
	path: MatchLegClass;
	/** Vertex-count / geometry fingerprint the gate emits, for the audit trail. */
	note: string;
	/**
	 * MEASURED symmetric polyline deviation between the two arms, in metres, at
	 * the coarse (decision) and path (display) layers — the figures
	 * `compare-match --gate` prints as `dev coarse=… path=…`.
	 *
	 * Required, not optional, and ENFORCED by {@link isAcceptedMatchDelta} — as a
	 * ceiling or an equality according to `basis` below. A leg holding its vertex
	 * counts while its line moves further than this is UNEXPLAINED either way. An
	 * entry without a measurement
	 * is the thing this re-derivation existed to remove: the reason field can then
	 * only assert, and an assertion nobody can check is indistinguishable from a
	 * guess. An entry whose measurement nothing reads is barely better — it is a
	 * checkable claim that never gets checked.
	 *
	 * These are LINE-to-line distances, not vertex-to-vertex. A vertex that slides
	 * along an otherwise identical polyline moves further than the line does — on
	 * leg 64c24f8ad38e6fbf, 0.79 m of vertex against 0.04 m of line. Since #400
	 * the class is derived from THIS figure at both vertex-count branches, because
	 * "did the line move?" is what the class is documented to mean. The gate
	 * prints the per-vertex separation alongside, so the two are never conflated
	 * and the one the class rests on is never the only one shown.
	 */
	coarseDevM: number;
	pathDevM: number;
	/**
	 * WHAT KIND of argument the `reason` makes — which decides how the recorded
	 * deviation is enforced. Required, with no default: a default would be the
	 * looser rule applying to an entry by omission, which is the failure this
	 * whole file exists to stop.
	 *
	 * `"magnitude"` — the reason argues from SIZE: this line moved so little that
	 * it cannot reach any threshold downstream. That argument only gets stronger
	 * as the deviation shrinks, so the figure is a CEILING and anything at or
	 * under it is covered.
	 *
	 * `"corridor"` — the reason argues from the QUALITY of one specific replayed
	 * route (building intrusion, stray p85, off-network distance, measured on a
	 * named date). "Smaller than 17.52 m" does NOT imply "the same corridor": a
	 * third route 9 m away would slip under a ceiling while being a route nobody
	 * looked at. So the figure is enforced as an EQUALITY — it is part of the
	 * divergence's identity, not a bound on it. These came from a deterministic
	 * fixture replay, so equality is a fair thing to demand: if the number moves,
	 * the corridor the sign-off measured is not the corridor being served.
	 */
	basis: "magnitude" | "corridor";
	/** Why this delta is accepted (human sign-off), citing its own numbers. */
	reason: string;
}

/**
 * The measured figure at the resolution the manifest records it in.
 *
 * Deliberately `toFixed(2)` and not an epsilon: every number in this file was
 * transcribed from what `compare-match --gate` printed, so the comparison is
 * made on the figure the sign-off was actually written against. An arbitrary
 * tolerance would be a second, undocumented threshold under the recorded one.
 *
 * BE PRECISE ABOUT WHAT THAT COSTS, because it is not nothing: rounding to two
 * decimals gives the measured side half a printed unit — 5 mm — of slop, so an
 * entry recorded at `0.01` in practice admits anything below 0.015, a 50%
 * margin at that magnitude. That is deliberate and it is the LOOSEST the rule
 * gets: 5 mm is the resolution a reviewer could distinguish on screen, so a
 * tighter test would fail on a difference nobody signing the entry could have
 * seen. It is bounded in absolute terms and irrelevant against the 18 m
 * threshold these figures are argued against. A manifest-shape test pins every
 * recorded figure to two decimals so the rounding cannot quietly become a finer
 * second threshold than the one documented here.
 */
const printedM = (m: number): number => Number(m.toFixed(2));

/** Sub-decimetre sign-off. The measured deviation is the argument; this spells
 *  out the threshold it is being measured against, so each entry states its own
 *  number without restating the reasoning 20 times. */
const bounded = (devM: number, layer: string): string =>
	`Float↔quant rounding, MEASURED 2026-07-31: the two ${layer} lines are ${devM.toFixed(2)} m apart ` +
	`(symmetric polyline deviation). The nearest threshold any of this feeds is matchImprovesDisplay's ` +
	`18 m off-road trigger and 40 m stray cap, so a deviation this size cannot change whether the match is ` +
	`kept, let alone which corridor is chosen. Bounded by measurement against a named threshold — not ` +
	`"display-only", which names the output field and bounds nothing (#395).`;

export const ACCEPTED_MATCH_DELTAS: readonly AcceptedMatchDelta[] = [
	// ── genuine route-choice flips — signed off individually ────────────────────
	{
		leg: "91167e4cf16f9ea8",
		date: "2026-06-28",
		hhmm: "10:35",
		coarse: "DIFF",
		path: "DIFF",
		note: "coarse 14v vs 13v, path 32v vs 28v",
		coarseDevM: 17.52,
		pathDevM: 17.52,
		basis: "corridor",
		reason:
			"REAL route-choice flip at a candidate-cost near-threshold — the lines are 17.52 m apart, three orders " +
			"of magnitude above the sub-decimetre class, and this is signed off on quality, not on size. MEASURED " +
			"2026-07-22 with both arms replayed on the identical leg: quant draws 450.4 m vs float's 471.6 m and " +
			"spends 41.3 m inside building footprints vs float's 60.1 m — 18.8 m LESS building intrusion — at " +
			"identical off-network distance (6.8 m) and 1.1 m more GPS stray (11.0 vs 9.9 p85, both far inside the " +
			"40 m cap, so matchImprovesDisplay holds on both arms). On the metric that matters for a pavement route " +
			"the verified arm is better, not merely different. Numbers are matcher output, BEFORE the " +
			"WALK_BUILDING_ESCAPE corrector downstream. NOT ground truth — which corridor was actually walked is " +
			"unknown — but nothing anomalous in the quantised cost function.",
	},
	{
		leg: "77277765451f43f5",
		date: "2026-06-29",
		hhmm: "08:43",
		coarse: "DIFF",
		path: "DIFF",
		note: "coarse 6v vs 5v, path 6v vs 5v",
		coarseDevM: 14.37,
		pathDevM: 14.37,
		basis: "corridor",
		reason:
			"REAL route-choice flip, lines 14.37 m apart. MEASURED 2026-07-22: a wash. Quant draws 205.1 m vs " +
			"float's 204.1 m, strays 24.0 m vs 26.5 m (p85, better) and sits 45.8 m inside buildings vs 38.8 m " +
			"(worse) — small deltas in opposite directions at identical off-network distance (16.0 m); both arms " +
			"stay inside the 40 m stray cap, so the keep/discard decision is unchanged either way. Weak evidence " +
			"in both directions: the raw track is a poor-GPS smear (254 m of its 435 m falls inside buildings), so " +
			"both arms are inferring from bad input. Neither picks a visibly wrong corridor. Accepted as a " +
			"knife-edge with no defect visible, NOT as a near-tie — 14 m is not a near-tie.",
	},
	// ── a vertex that slid ALONG the line — the #400 case ───────────────────────
	{
		leg: "64c24f8ad38e6fbf",
		date: "2026-05-15",
		hhmm: "20:47",
		coarse: "NEAR",
		path: "EXACT",
		note: "coarse 10v vs 10v, path 53v vs 53v",
		coarseDevM: 0.04,
		pathDevM: 0.0,
		basis: "magnitude",
		reason:
			"One of ten coarse vertices sits 78.7 cm from its counterpart — but it slid mostly ALONG the line, so " +
			"the two coarse polylines measure 0.04 m apart and the display path is BIT-IDENTICAL (53v vs 53v, " +
			"0.00 m). Four centimetres against an 18 m off-road trigger and a 40 m stray cap: real, bounded, " +
			"changed nothing served. " +
			"Was the corpus's third coarse DIFF and previously unsigned — it had no manifest entry at all while " +
			"two other coarse DIFFs did. It read DIFF only because the equal-vertex-count branch graded " +
			"per-COORDINATE while the length-mismatch branch already graded by line distance, so two legs whose " +
			"lines were both 0.04 m apart got opposite classes depending on how the arms happened to sample them. " +
			"#400 made both branches answer the one question the class is documented to answer — did the LINE " +
			"move? — and this leg is the only one in the corpus the change moves. `compare-match` prints the " +
			"per-vertex separation (0.79 m) beside the deviation (0.04 m), so the class is shown its evidence and " +
			"the reclassification hides nothing: this leg is still reported, still needs this entry, and still " +
			"fails the gate without it.",
	},
	// ── sub-decimetre: coarse layer moved, within 4 cm ───────────────────────────
	{
		leg: "cf8fa2efd60d5dc6",
		date: "2026-04-30",
		hhmm: "15:16",
		coarse: "NEAR",
		path: "DIFF",
		note: "coarse 4v vs 4v, path 17v vs 17v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "coarse and display"),
	},
	{
		leg: "2742a9a5725284a7",
		date: "2026-05-22",
		hhmm: "14:14",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 16v vs 16v, path 56v vs 56v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "coarse and display"),
	},
	{
		leg: "40ff0cab9a7f05ff",
		date: "2026-06-16",
		hhmm: "16:07",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 45v vs 45v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "coarse and display"),
	},
	{
		leg: "2e242afcfc715c06",
		date: "2026-06-28",
		hhmm: "11:17",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 22v vs 22v, path 40v vs 40v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "coarse and display"),
	},
	{
		leg: "c2a41b102bb69756",
		date: "2026-07-02",
		hhmm: "14:36",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 23v vs 23v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "coarse and display"),
	},
	{
		leg: "ffe15274e404878f",
		date: "2026-07-06",
		hhmm: "10:34",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 15v vs 15v, path 57v vs 57v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason: bounded(0.0, "coarse and display"),
	},
	// ── sub-decimetre: coarse decision identical, display splice only ────────────
	{
		leg: "eea8cfc6b2703872",
		date: "2026-04-29",
		hhmm: "14:19",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 12v vs 12v, path 46v vs 46v",
		coarseDevM: 0.0,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "display"),
	},
	{
		leg: "ec77d1b73443d289",
		date: "2026-04-29",
		hhmm: "14:50",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 32v vs 32v, path 66v vs 66v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "display"),
	},
	{
		leg: "8bfdeba62a10b7f3",
		date: "2026-05-11",
		hhmm: "19:59",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 25v vs 25v, path 81v vs 82v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason:
			`${bounded(0.0, "display")} The arms disagree by one display vertex (81v vs 82v) — a redundant ` +
			"collinear point, not a detour; this leg is why the length-mismatch branch grades by distance (#396).",
	},
	{
		leg: "2d288f1de88f721d",
		date: "2026-05-25",
		hhmm: "11:31",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 10v vs 10v, path 23v vs 23v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason: bounded(0.0, "display"),
	},
	{
		leg: "687ab4f68894ac57",
		date: "2026-06-09",
		hhmm: "17:45",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 9v vs 9v, path 40v vs 41v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason: `${bounded(0.0, "display")} One redundant collinear display vertex (40v vs 41v), as with 05-11.`,
	},
	{
		leg: "fcb19c04f6001234",
		date: "2026-06-15",
		hhmm: "16:41",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 9v vs 9v, path 62v vs 62v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason: bounded(0.0, "display"),
	},
	{
		leg: "69e5896e7e0da12b",
		date: "2026-06-17",
		hhmm: "10:03",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 15v vs 15v, path 53v vs 53v",
		coarseDevM: 0.0,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "display"),
	},
	{
		leg: "894321fc1310bf77",
		date: "2026-06-24",
		hhmm: "18:33",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 28v vs 28v, path 76v vs 76v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason: `${bounded(0.0, "display")} Previously had NO entry — the corpus reached this leg and the manifest never did.`,
	},
	{
		leg: "738a577a85c566fc",
		date: "2026-07-02",
		hhmm: "07:45",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 9v vs 9v, path 36v vs 36v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "display"),
	},
	{
		leg: "12bcacd9d10f3e9b",
		date: "2026-07-02",
		hhmm: "15:10",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 10v vs 10v, path 37v vs 37v",
		coarseDevM: 0.01,
		pathDevM: 0.0,
		basis: "magnitude",
		reason: bounded(0.01, "display"),
	},
	{
		leg: "5acb9ecb0d6ea26f",
		date: "2026-07-12",
		hhmm: "14:02",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 23v vs 23v, path 64v vs 65v",
		coarseDevM: 0.0,
		pathDevM: 0.01,
		basis: "magnitude",
		reason:
			`${bounded(0.01, "display")} THE #396 REFERENCE LEG: 64v vs 65v, two polylines 0.01 m apart. Graded ` +
			"DIFF by the old structural rule, which is what put it in the same class as a 120 m reroute.",
	},
	{
		leg: "e25c46e909145d80",
		date: "2026-07-17",
		hhmm: "09:31",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 12v vs 12v, path 42v vs 42v",
		coarseDevM: 0.0,
		pathDevM: 0.01,
		basis: "magnitude",
		reason: bounded(0.01, "display"),
	},
	{
		leg: "a28db136844e4ddf",
		date: "2026-07-17",
		hhmm: "14:33",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 36v vs 36v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason: bounded(0.0, "display"),
	},
	{
		// The 23rd entry, and the only one not measured in the 2026-07-31
		// re-derivation — 2026-07-30 was not in the gated corpus then. #407
		// promoted it; this leg is what the promotion surfaced.
		leg: "f1a37e256633c480",
		date: "2026-07-30",
		hhmm: "09:28",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 8v vs 8v, path 14v vs 14v",
		coarseDevM: 0.0,
		pathDevM: 0.01,
		basis: "magnitude",
		reason:
			"Float↔quant rounding, MEASURED 2026-08-02 (not in the 2026-07-31 re-derivation — the day was still in " +
			"adhoc-days/ and ungated). UCLH → Euston Square, the 10:28–10:39 BST walk. Both arms keep the SAME vertex " +
			"counts at both layers (8v coarse, 14v display) and the two display lines are 0.01 m apart; the coarse " +
			"lines are identical at the recorded resolution. That is the sub-decimetre population this file " +
			"documents (20 of 22 legs at 0.00–0.04 m), four orders of magnitude under matchImprovesDisplay's 18 m " +
			"off-road trigger and 40 m stray cap, so it cannot change whether the match is kept or which corridor " +
			"is chosen — the failure mode #398 found on 71e5544efa614a06, which is the OTHER 07-30 walk and is now " +
			"bit-clean after #406. Held in the delta CEILING as un-adjudicated debt from the promotion until this " +
			"measurement; moved here once measured, which is the direction that file is supposed to flow.",
	},
];

const accepted = new Map<string, AcceptedMatchDelta>(ACCEPTED_MATCH_DELTAS.map((d) => [d.leg, d]));

/**
 * True iff this measured leg divergence is in the accepted manifest — same leg
 * fingerprint, same coarse/path classes, same note, AND both measured
 * deviations at or under the ones this entry was signed off at.
 *
 * Keyed on the leg's own input (`legFingerprint`), not on its position in the
 * golden calendar, so the SAME call adjudicates the gate (golden days) and the
 * production ledger (live days the corpus does not contain).
 *
 * ── WHY THE MEASUREMENT IS PART OF THE TEST ─────────────────────────────────
 *
 * Until this was wired the recorded deviations were AUDITABLE BUT NOT ENFORCED:
 * acceptance turned on `(leg, coarse, path, note)` alone, and `note` is a vertex
 * COUNT. So a leg could keep its counts, move a hundred metres, and still be
 * tagged `accepted`. That is not a hypothetical shape — it is the King's Cross
 * leg (71e5544efa614a06, #398), whose coarse note stayed `17v vs 17v` while the
 * line moved 120 m and production stopped drawing the match at all. The number
 * that would have caught it was already being measured and printed; nothing read
 * it.
 *
 * ── CEILING OR EQUALITY, PER ENTRY ──────────────────────────────────────────
 *
 * Not one rule. Which one applies is `basis`, and it follows from what the
 * entry's `reason` actually argues (see the field's own docs).
 *
 * Most entries argue from MAGNITUDE: "the two lines are 0.04 m apart … the
 * nearest threshold any of this feeds is 18 m / 40 m, so a deviation this size
 * cannot change whether the match is kept". That argument stays true for
 * anything smaller, so the figure is a CEILING — the same ratchet direction as
 * the golden gate's feasibility ceilings, where a day may only improve.
 * Demanding equality there would fail the gate on a leg that moved from 0.02 m
 * to 0.01 m, which is the manifest refusing an improvement.
 *
 * Two entries do NOT argue that way, and a ceiling would be wrong for them.
 * 91167e4cf16f9ea8 (17.52 m) and 77277765451f43f5 (14.37 m) are genuine
 * route-choice flips signed off on the measured QUALITY of one replayed
 * corridor — building intrusion, stray p85, off-network distance, all from a
 * fixed replay on 2026-07-22. Under a ceiling, a quant arm that picked a THIRD
 * route 9 m away would be auto-accepted by a sign-off that measured a different
 * one; the vertex-count note guards that only incidentally, not by design. So
 * those are enforced as an EQUALITY: the figure is part of the divergence's
 * identity, and if it moves, what is being served is not what was reviewed.
 *
 * A `null` deviation is REJECTED under either basis, not waived. `null` means
 * one arm matched and the other did not, so there is no distance between the
 * two lines — and you cannot bound what was never measured. It also means no
 * null-flip can ever be accepted here, which is the correct answer for that
 * class: a leg one arm declines to match at all is the loudest divergence there
 * is.
 */
export function isAcceptedMatchDelta(
	leg: string,
	coarse: MatchLegClass,
	path: MatchLegClass,
	note: string,
	dev: { coarse: number | null; path: number | null },
): boolean {
	const d = accepted.get(leg);
	if (d === undefined || d.coarse !== coarse || d.path !== path || d.note !== note) return false;
	if (dev.coarse === null || dev.path === null) return false;
	const ok = (measured: number, recorded: number): boolean =>
		d.basis === "corridor" ? printedM(measured) === recorded : printedM(measured) <= recorded;
	return ok(dev.coarse, d.coarseDevM) && ok(dev.path, d.pathDevM);
}

/** Tag a measured divergence for a ledger line. */
export function matchDeltaTag(
	leg: string,
	coarse: MatchLegClass,
	path: MatchLegClass,
	note: string,
	dev: { coarse: number | null; path: number | null },
): "accepted" | "UNEXPLAINED" {
	return isAcceptedMatchDelta(leg, coarse, path, note, dev) ? "accepted" : "UNEXPLAINED";
}
