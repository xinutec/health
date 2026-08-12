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
	/**
	 * The worst per-vertex SEPARATION, in metres, across both layers — declared
	 * only when it exceeds the line deviations above, and ENFORCED as a ceiling
	 * when it is (#401).
	 *
	 * A vertex that slides ALONG an otherwise identical polyline moves further
	 * than the line does, and `polylineDeviationM` is insensitive to where along
	 * a straight run a vertex sits. So a leg can hold a 0.01 m line bound while a
	 * vertex travels metres, which is not a hypothetical: `cf8fa2efd60d5dc6`
	 * slides 5.87 m and `480b1b141d902740` slides 12.22 m, both at 0.01 m of
	 * line. Optional rather than required because on 24 of the corpus's 28
	 * divergences the separation is at or under the deviation and carries no
	 * information — a field that reads `0.01` twenty-four times teaches a reader
	 * to skip it, and then the three that matter are skipped too.
	 */
	vtxM?: number;
	/**
	 * The worst per-vertex TIMESTAMP shift, in whole seconds, across both layers
	 * — declared only when above `IRREDUCIBLE_DTS_S`, and enforced when it is.
	 *
	 * This is the axis a reader can actually see. `episode-geometry.ts` clips the
	 * drawn path by these timestamps, so a shift across a state-window boundary
	 * changes which vertices are drawn at all; and the map's tap-inspector renders
	 * the chosen vertex's `ts` with `second: "2-digit"`, so the difference between
	 * the two arms is legible in the popup. #401 flagged the question and said not
	 * to sign it off in either direction unmeasured; measured 2026-08-11, the
	 * answer is that it reaches the screen.
	 */
	dtsS?: number;
	/** Why this delta is accepted (human sign-off), citing its own numbers. */
	reason: string;
}

/**
 * The timestamp shift that carries no information, in seconds.
 *
 * Both arms round an INTERPOLATED timestamp to a whole second (`quantPt`), so
 * two interpolations of the same instant can land a second apart with nothing
 * having moved. That makes 1 s the floor of the measurement rather than a
 * tolerance someone chose — derived, not picked, which is the distinction this
 * file keeps insisting on. Five corpus legs sit at exactly 1 s and one sits at
 * 27 s, and the gap between those is the whole point: 27 s is not rounding.
 */
const IRREDUCIBLE_DTS_S = 1;

/**
 * The vertex separation that carries no information, in metres.
 *
 * An implicit bound of "no further than the line moved" was the first attempt
 * and it was wrong in a way only running it showed: six legs recorded at
 * `dev 0.00` measure `vtx 0.01`, which is ONE step of the two-decimal
 * resolution both figures are printed at, not a slide. Holding them to 0.00
 * failed six signed-off legs on rounding.
 *
 * So the floor is read off the corpus the same way the header reads the
 * deviation populations, and the gap is just as clean: 25 of the 28 divergences
 * sit at or under 0.14 m of separation, and the other three are 0.79 m, 5.87 m
 * and 12.22 m. 0.20 m falls in the empty space between those populations with
 * room either side, so it separates "the last decimal place disagreed" from "a
 * vertex travelled", which is the distinction this bound is for. Anything above
 * it must be declared per entry and is then enforced at the declared figure.
 */
const IRREDUCIBLE_VTX_M = 0.2;

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
const boundedAt = (devM: number, layer: string, measuredOn: string): string =>
	`Float↔quant rounding, MEASURED ${measuredOn}: the two ${layer} lines are ${devM.toFixed(2)} m apart ` +
	`(symmetric polyline deviation). The nearest threshold any of this feeds is matchImprovesDisplay's ` +
	`18 m off-road trigger and 40 m stray cap, so a deviation this size cannot change whether the match is ` +
	`kept, let alone which corridor is chosen. Bounded by measurement against a named threshold — not ` +
	`"display-only", which names the output field and bounds nothing (#395).`;

/** The 2026-07-31 re-derivation's sign-off. Kept as the original one-argument
 *  form so its twenty entries below are untouched by the date becoming a
 *  parameter — a mass edit of signed-off text to add a field is how a sign-off
 *  stops being the thing that was signed. */
const bounded = (devM: number, layer: string): string => boundedAt(devM, layer, "2026-07-31");

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
		// #401's own leg, and the only entry in this file whose sign-off is about
		// a TIME rather than a distance. Both extra figures are declared, so the
		// gate now holds it to all three axes instead of to the 0.01 m line bound
		// that said nothing about either.
		vtxM: 5.87,
		dtsS: 27,
		reason:
			`${bounded(0.01, "coarse and display")} SLIDE AND SHIFT, measured 2026-08-11 (#401): the lines agree ` +
			"to 0.01 m, but one display vertex sits 5.87 m along the line from its counterpart and carries a " +
			"timestamp 27 SECONDS apart. Both are declared and enforced here because the line deviation cannot " +
			"see either — a vertex sliding along an otherwise identical polyline is invisible to " +
			"polylineDeviationM by construction. 27 s is the largest shift in the corpus by a factor of 27 " +
			"against the 1 s floor two whole-second roundings can produce, so it is NOT rounding and is not " +
			"claimed to be. What it is instead: SIGNED OFF ON ITS CONSEQUENCE, by Pippijn on 2026-08-11, having " +
			"been shown what it costs. The consequence is bounded and was traced rather than assumed — the " +
			"interpolated ts reaches exactly two readers (api.ts:469 strips the segment-level path arrays, so " +
			"nothing else sees it). episode-geometry clips the drawn path by it, where 27 s can move a vertex " +
			"across a state-window boundary and change which vertices are drawn — cosmetic at one end of one " +
			"leg, since the line itself is identical. And the map tap-inspector renders it at second precision, " +
			"so tapping THIS vertex can report a time up to 27 s off depending on which arm drew the line. " +
			"Nothing decides anything on it: the coarse layer feeds matchImprovesDisplay geometrically, and " +
			"these lines are 0.01 m apart. Accepted as a display-time imprecision on one vertex of one leg, " +
			"NOT as rounding. Which arm's timestamp is nearer the truth is unknown and unknowable from the " +
			"data — that is why this is a ceiling on a consequence and not a claim about correctness, and why " +
			"a leg that shifts FURTHER than 27 s still fails.",
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
		leg: "5a916603a1b96a07",
		date: "2026-06-16",
		hhmm: "15:48",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 29v vs 29v, path 66v vs 67v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason:
			`${boundedAt(0.0, "display", "2026-08-11")} The display counts differ by one vertex (66v vs 67v), so ` +
			"the deviation is a POLYLINE measure rather than a positional one — there is no vertex pairing to " +
			"slide along, and #401's along-line hazard cannot arise on this leg.",
	},
	{
		leg: "9885d2a5873db953",
		date: "2026-07-17",
		hhmm: "14:33",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 35v vs 35v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason:
			`${boundedAt(0.0, "display", "2026-08-11")} RE-KEYED: supersedes a28db136844e4ddf at the same date ` +
			"and start minute. Worst display vertex separation 0.01 m.",
	},
	{
		leg: "840aff22fab124fe",
		date: "2026-08-06",
		hhmm: "08:38",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 9v vs 9v, path 31v vs 31v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason:
			`${boundedAt(0.01, "coarse and display", "2026-08-11")} First adjudication for this leg: 2026-08-06 ` +
			"entered the gated corpus after the 2026-07-31 re-derivation. Worst vertex separation 0.01 m at " +
			"both layers, so the line and its vertices moved by the same negligible amount (#401).",
	},
	{
		leg: "c907b7bb2e0c96f9",
		date: "2026-08-06",
		hhmm: "10:21",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 6v vs 6v, path 12v vs 12v",
		coarseDevM: 0.14,
		pathDevM: 0.14,
		basis: "magnitude",
		reason:
			"Float↔quant rounding, MEASURED 2026-08-11 and the only leg of this batch INSPECTED vertex by vertex, " +
			"because at 0.14 m it stood an order of magnitude above the other seven and that gap deserved an " +
			"explanation rather than a bound. The explanation is that the line did not drift: both arms agree " +
			"BIT-FOR-BIT on every vertex of both layers except the LAST one, which sits 13.6 cm away (Δlat=-12, " +
			"Δlon=-4 units, Δts=0). So the 0.14 m symmetric deviation is one endpoint, not a wandering polyline, " +
			"and the vertex separation equals it rather than exceeding it — the #401 hazard is absent by " +
			"construction here. 13.6 cm is below the metre-scale accuracy of the GPS being matched, so the two " +
			"arms disagree by less than the input can resolve, and it is ~130x under matchImprovesDisplay's 18 m " +
			"off-road trigger and 40 m stray cap. quant↔lean EXACT, so this is float-vs-quantised arithmetic and " +
			"not a Lean divergence.",
	},
	// ── the floor: nothing moved, one timestamp rounded the other way ───────────
	{
		leg: "62c433a17fde0a56",
		date: "2026-08-10",
		hhmm: "18:19",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 14v vs 14v, path 33v vs 33v",
		coarseDevM: 0.01,
		pathDevM: 0.01,
		basis: "magnitude",
		reason:
			"The smallest divergence this system can produce, signed off 2026-08-12 (#743). Once both arms are " +
			"on the 1e-7° grid the two lines are IDENTICAL: `--leg` reports Δlat=0, Δlon=0 at every vertex of " +
			"both layers, worst separation 0.0 cm on the 14v coarse path and 0.0 cm on the 33v display path. The " +
			"only supra-unit difference in the whole leg is display vertex [13], whose timestamp is ONE SECOND " +
			"apart (Δts=-1). " +
			"That second is IRREDUCIBLE_DTS_S, the floor derived in #401: both arms round an interpolated " +
			"timestamp to a whole second, so two interpolations of the same instant can land a second apart with " +
			"nothing having moved. Five corpus legs already sit at exactly 1 s. " +
			"The 0.01 m recorded here is NOT that vertex and not a line that moved — it is the sub-unit residual, " +
			"because `legDeviations` / `legVertexSeparations` compare the RAW float arm against the quant arm " +
			"while `comparePaths` quantises the float arm first. So the class sees a grid-exact line and the " +
			"deviation sees half a grid unit (~1.11 cm of latitude at London), which `toFixed(2)` renders 0.01. " +
			"Recording 0.0 would be tighter than the instrument: it is what `--leg` prints, on a different " +
			"comparison from the one the gate enforces. " +
			"It reads NEAR rather than EXACT only because EXACT demands bit-identical rows INCLUDING ts, and it " +
			"read UNEXPLAINED only because a LIVE leg has no manifest entry — 2026-08-10 is not in the 35-day " +
			"corpus. Neither is a statement about size. Re-measured before signing: `scripts/compare-match.sh " +
			"--days tests/golden/adhoc-days --leg 62c433a17fde0a56 2026-08-10`, whose fixture is kept outside the " +
			"gated corpus so this stays reproducible without prod. " +
			"vtxM and dtsS are left undeclared per this file's convention — declare only above the floor — so the " +
			"gate holds it to IRREDUCIBLE_VTX_M (0.2 m) and IRREDUCIBLE_DTS_S (1 s). Anything past either is a " +
			"new divergence and fails, which is the intent: this sign-off says the line did not move, not that " +
			"movement is tolerated. quant↔lean EXACT, so this is float-vs-quantised arithmetic, not a Lean " +
			"divergence.",
	},
	// ── #747: one extra display vertex, 2.26 m, on a bit-identical decision layer ─
	{
		leg: "a0f21eac57625068",
		date: "2026-08-08",
		hhmm: "15:11",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 11v vs 11v, path 23v vs 24v",
		coarseDevM: 0.0,
		pathDevM: 2.26,
		basis: "magnitude",
		reason:
			"Signed off 2026-08-12 (#747), the second of the two live divergences `LEAN_MATCH=on` reported on its " +
			"first production run. The COARSE layer — the one `matchImprovesDisplay` reads — agrees BIT-FOR-BIT, " +
			"11v vs 11v at 0.00 m, so the keep/discard decision and the corridor choice are untouched. Both arms " +
			"also agree on WHERE the walk went: every float vertex lies exactly on the quant polyline (0.00 m in " +
			"that direction). The whole divergence is ONE EXTRA VERTEX in the quant display path — 24v against " +
			"23v — sitting up to 2.26 m off the float line: a small detour one arm draws and the other smooths " +
			"through. It classes DIFF rather than NEAR only because 2.26 m exceeds the 0.33 m NEAR band, which " +
			"is a statement about the band, not about risk — the thresholds this feeds are an 18 m off-road " +
			"trigger and a 40 m stray cap, ~8x away. " +
			"NOT a candidate-cut coin flip (#406): `--candidates` over the whole day finds exactly one fix where " +
			"the arms kept different segments, and it is on the 11:02 leg, which is `path=EXACT`. On this leg " +
			"both arms kept the same candidates, so this is a genuine small geometric difference rather than a " +
			"top-K tie. " +
			"vtx and dts are `n/a` on the path layer — differing vertex counts means there is no vertex " +
			"correspondence to measure, and the polyline branch already measured the only thing there is. " +
			"Undeclared per this file's convention. 2026-08-08 is a LIVE day, not corpus; its fixture is kept at " +
			"`tests/golden/adhoc-days/` so this stays reproducible without prod, and it was re-captured and " +
			"re-measured on 2026-08-12 before signing — every figure identical. quant↔lean EXACT.",
	},
	// ── #800: six sign-offs re-keyed by the walk-boundary passes ─────────────────
	//
	// `466ceb0` / `cc16e69` (arrival trim), `bdef95f` (ride-tail trim) and
	// `b017a1d` (way-name rename) redraw walks, and `legFingerprint` digests a
	// leg's quantised INPUT FIXES — so every one of these lost its key while the
	// divergence itself stood still. Each entry below states the stranded entry
	// it replaces, and each was re-measured 2026-08-12 against `compare-match
	// --gate` before being carried over. NOT ONE FIGURE MOVED.
	//
	// Three also carry a SHORTER display path (05-15, 06-15, 07-12), because the
	// arrival trim removed a standing tail and the walk map-matches to fewer
	// vertices. That changes `note`, which is part of an entry's identity, so
	// those could not have matched their predecessors even had the key survived.
	// Their deviation and vertex figures are unchanged on every axis.
	//
	// #662 measured the alternative keys and decided to keep the content key
	// (day + `hh:mm` reclaimed only 2 of 9; the start minute moves too). This is
	// the standing cost of that decision, not a reason to reopen it.
	{
		leg: "3bb671f84b4194d4",
		date: "2026-04-29",
		hhmm: "17:44",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 21v vs 21v, path 61v vs 61v",
		coarseDevM: 0.0,
		pathDevM: 0.01,
		basis: "magnitude",
		vtxM: 12.22,
		reason:
			"SUPERSEDES `480b1b141d902740`, the same leg under its pre-`b017a1d` fingerprint. Re-measured " +
			"2026-08-12: class, note, deviation and vertex slide are all IDENTICAL to what was signed at " +
			"`e39d855` on 2026-08-11 — only the key moved. " +
			"The original sign-off, unchanged in substance: float↔quant rounding with an ALONG-LINE vertex " +
			"slide, inspected vertex by vertex. The coarse (decision) layer is BIT-IDENTICAL, 21v vs 21v at " +
			"0.0 cm, so nothing feeding matchImprovesDisplay differs and the keep/discard decision is untouched. " +
			"On the display layer 60 of 61 vertices are bit-identical and vertex [19] sits 12.18 m away with its " +
			"timestamp 1 SECOND apart. That combination is what bounds it: 12 m of slide carrying only 1 s means " +
			"the vertex is a different point on the SAME polyline (the two lines measure 0.01 m apart), not a " +
			"different route and not a different time. The reader-visible consequence is the tap-inspector " +
			"attributing a time 1 s different to a tap in that spot — the irreducible floor of a timestamp both " +
			"arms round to whole seconds.",
	},
	{
		leg: "9732d1ede0be6d9e",
		date: "2026-05-15",
		hhmm: "20:47",
		coarse: "NEAR",
		path: "EXACT",
		note: "coarse 10v vs 10v, path 47v vs 47v",
		coarseDevM: 0.04,
		pathDevM: 0.0,
		basis: "magnitude",
		vtxM: 0.79,
		reason:
			"SUPERSEDES `64c24f8ad38e6fbf`, the same leg re-keyed AND re-drawn. Both deviation figures and the " +
			"0.79 m vertex slide are IDENTICAL to the signed entry; what changed is the display path, 53v → 47v, " +
			"because the arrival trim (`466ceb0` / `cc16e69`) took a standing tail off the walk and it " +
			"map-matches to six fewer vertices. A shorter walk, the same disagreement about it. " +
			"The original sign-off, unchanged in substance (#400 / #401): one of ten coarse vertices sits 78.7 cm " +
			"from its counterpart, but it slid mostly ALONG the line, so the two coarse polylines measure 0.04 m " +
			"apart and the display path is BIT-IDENTICAL. Four centimetres against an 18 m off-road trigger and " +
			"a 40 m stray cap: real, bounded, changed nothing served. `compare-match` prints the per-vertex " +
			"separation beside the deviation, so the class is shown its evidence.",
	},
	{
		leg: "9e9011f56fed052c",
		date: "2026-06-15",
		hhmm: "16:40",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 9v vs 9v, path 55v vs 55v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason:
			"SUPERSEDES `f284eacbbeb66b27`, the same leg re-keyed AND re-drawn: display path 62v → 55v after the " +
			"arrival trim shortened the walk. Both deviations remain 0.00 m and the worst vertex separation is " +
			"0.01 m, so the lines agree to the quantisation floor at both layers — identical to what was signed " +
			"at `eb9af29` on 2026-08-11. Float↔quant rounding, bounded by measurement against " +
			"matchImprovesDisplay's 18 m off-road trigger and 40 m stray cap. quant↔lean EXACT.",
	},
	{
		leg: "aba3df446294f0a9",
		date: "2026-06-17",
		hhmm: "16:34",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 62v vs 62v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason:
			"SUPERSEDES `6d105ef6b32c015f`. A PURE re-keying: class, note and both deviations are byte-identical " +
			"to the entry signed at `eb9af29` on 2026-08-11 — even the vertex counts match, because this walk's " +
			"matched geometry is unchanged. Only `legFingerprint` moved, since it digests the leg's input fixes " +
			"and a boundary pass redrew them. Both lines agree at 0.00 m with a worst vertex separation of " +
			"0.05 m, an order below the 0.2 m floor an undeclared `vtxM` enforces. quant↔lean EXACT.",
	},
	{
		leg: "ead435b647bfb446",
		date: "2026-06-24",
		hhmm: "18:33",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 28v vs 28v, path 76v vs 76v",
		coarseDevM: 0.0,
		pathDevM: 0.0,
		basis: "magnitude",
		reason:
			"SUPERSEDES `894321fc1310bf77`. A PURE re-keying, like 06-17: class, note and both deviations are " +
			"byte-identical to the entry signed at `eb9af29` on 2026-08-11, and the 76-vertex display path is " +
			"unchanged. Both lines agree at 0.00 m, worst vertex separation 0.01 m. quant↔lean EXACT.",
	},
	{
		leg: "ba5f268dab9dbc79",
		date: "2026-07-12",
		hhmm: "14:02",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 23v vs 23v, path 56v vs 57v",
		coarseDevM: 0.0,
		pathDevM: 0.01,
		basis: "magnitude",
		reason:
			"SUPERSEDES `5acb9ecb0d6ea26f`, the same leg re-keyed AND re-drawn: display path 64v/65v → 56v/57v " +
			"after the arrival trim shortened the walk. The ONE-EXTRA-VERTEX asymmetry is preserved across the " +
			"redraw — one arm still draws a single vertex the other does not — and both deviations are unchanged " +
			"at 0.00 m coarse and 0.01 m path, identical to the signed entry. vtx is `n/a` on the path layer " +
			"because the counts differ and there is no vertex correspondence to measure; the polyline branch " +
			"already measured the only thing there is. quant↔lean EXACT.",
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
	vtx?: { coarse: number | null; path: number | null },
	dts?: { coarse: number | null; path: number | null },
): boolean {
	const d = accepted.get(leg);
	if (d === undefined || d.coarse !== coarse || d.path !== path || d.note !== note) return false;
	if (dev.coarse === null || dev.path === null) return false;
	const ok = (measured: number, recorded: number): boolean =>
		d.basis === "corridor" ? printedM(measured) === recorded : printedM(measured) <= recorded;
	if (!ok(dev.coarse, d.coarseDevM) || !ok(dev.path, d.pathDevM)) return false;

	// The two axes the line deviation cannot see (#401). Both are optional
	// ARGUMENTS but not optional CHECKS: an entry that does not declare a bound
	// is asserting the measurement stays within the deviation it did record, and
	// that assertion is tested here rather than trusted. Skipping the check when
	// the field is absent would make the default the loose one, which is exactly
	// what `basis` is documented as refusing to do.
	//
	// `null` (no vertex correspondence — differing counts) is not a failure the
	// way a null DEVIATION is. There, null means the lines could not be compared
	// at all; here it means the polyline branch already measured the only thing
	// there is to measure, and a per-vertex figure is undefined rather than
	// missing.
	if (vtx !== undefined) {
		const worst = Math.max(vtx.coarse ?? 0, vtx.path ?? 0);
		const bound = d.vtxM ?? Math.max(d.coarseDevM, d.pathDevM, IRREDUCIBLE_VTX_M);
		if (printedM(worst) > bound) return false;
	}
	if (dts !== undefined) {
		const worst = Math.max(dts.coarse ?? 0, dts.path ?? 0);
		if (worst > (d.dtsS ?? IRREDUCIBLE_DTS_S)) return false;
	}
	return true;
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
