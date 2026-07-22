/**
 * The accepted float↔quant delta manifest for the verified walk MATCHER.
 *
 * The matcher analogue of `accepted-deltas.ts` (which covers the geometry
 * passes). When `LEAN_MATCH=on` serves the verified Lean matcher, production
 * adopts the quantised (1e-7° integer) arithmetic as truth. On a handful of
 * golden legs that differs from the TS float matcher:
 *
 *   NEAR — same decision (same null-ness + vertex counts), coordinates within
 *          30 cm: a route near-tie where float vs quant rounding lands the
 *          matched line a few cm apart. Display-only.
 *   DIFF — a genuine decision flip: different null-ness, or different vertex
 *          geometry (e.g. the building-penalty in/out flip, where a
 *          through-building edge's unsupported-crossing cost lands just either
 *          side of the detour threshold under float vs quant arithmetic).
 *
 * The `compare-match` quant↔Lean layer is bit-exact (the BigInt twin and Lean
 * agree 185/185), so serving Lean == serving the quant twin. These float↔quant
 * legs are therefore exactly the legs whose PRODUCTION BEHAVIOUR changes when
 * the flip lands — the set that must be inspected and signed off first.
 *
 * This manifest is the *closed set* of such divergences we have inspected and
 * accept. The flip gate (`compare-match --gate`) asserts the measured float↔
 * quant NEAR/DIFF set is a subset of this manifest: any NEW or unexplained
 * divergence — a different leg, a different class, a different vertex signature
 * — fails the gate. That is the honest boundary between "known, bounded,
 * signed-off" and "a real behaviour change we have not reviewed".
 *
 * Each entry is keyed by golden day + leg start (hh:mm UTC) + the coarse/path
 * classes, so a match is an exact fingerprint of the divergence, not a fuzzy
 * "some leg of this day".
 */

export type MatchLegClass = "EXACT" | "NEAR" | "DIFF";

export interface AcceptedMatchDelta {
	/** Golden day (YYYY-MM-DD) of the diverging leg. */
	date: string;
	/** Leg start, hh:mm UTC (as `compare-match` prints it). */
	hhmm: string;
	/** The coarse (decision-layer) float↔quant class. */
	coarse: MatchLegClass;
	/** The path (display-splice) float↔quant class. */
	path: MatchLegClass;
	/** Vertex-count / geometry fingerprint the gate emits, for the audit trail. */
	note: string;
	/** Why this delta is accepted (human sign-off). */
	reason: string;
}

/**
 * RE-DERIVED 2026-07-22 on the corrected leg population (`npm run compare-match
 * -- --gate`): **185 legs**, quant↔Lean **185/185** bit-EXACT, 21 float↔quant
 * deltas.
 *
 * The previous set (173 legs) was measured over legs the gate RECONSTRUCTED —
 * windowed from HSMM episodes with a bbox slice of the day's OSM trace — which
 * is not the population production matches. `annotateWalkMatches` now records
 * the legs it actually feeds the matcher and the gate consumes those, so this
 * manifest finally enumerates divergences in SERVED output. The re-derivation
 * moved almost every entry: 12 more legs, different per-leg candidate way sets,
 * and therefore different vertex counts — e.g. 2026-05-11 19:59 went from
 * `path 69v vs 70v` to `75v vs 76v`, 2026-06-23 08:16 and 2026-07-07 08:42
 * dropped out entirely, and 2026-06-16 15:48 / 06-29 08:43 appeared. The old
 * numbers are not comparable to these; they measured a different thing.
 *
 * Cross-check that the population is now the served one: the gate finds exactly
 * two divergent legs on 2026-07-17 (09:31, 14:33), which is exactly what the
 * production ledger reports serving that day (`path=2` per run). Before the
 * fix the gate called that day clean.
 *
 * SAFETY BASIS for accepting all 21: the walk matcher's output is
 * `walkMatchedPath` — DISPLAY geometry only (pedestrian-match-annotate is
 * "purely additive: never rewrites mode or fixes, only adds display geometry").
 * Its only readers are renderers / a debug dump / an api.ts path that strips it;
 * NO decision (HSMM decode, place attribution, mode) reads it. So even a coarse
 * route-choice flip changes only the drawn pavement polyline for one leg, never
 * what a day means. Combined with quant↔Lean bit-exactness, serving Lean is
 * display-safe on the corpus.
 *
 * Three classes (each leg still enumerated individually):
 *   - path-only (coarse EXACT): the route decision is identical; only the
 *     spliced display curve differs — ≤30 cm (NEAR) or a splice-insertion
 *     vertex (DIFF). The matcher analogue of the passes' Douglas-Peucker
 *     near-ties.
 *   - coarse NEAR: same drawn route, every vertex within 30 cm under float↔
 *     quant rounding.
 *   - coarse DIFF (2): genuine route-choice flips at a cost near-threshold —
 *     06-28 10:35 (14v vs 13v coarse, 32v vs 28v path) and 06-29 08:43 (a
 *     6-vertex leg losing one). NEITHER has been visually reviewed on this
 *     population; both are accepted on the display-only safety basis above,
 *     not on inspection, and both are flagged in their entries. Reviewing them
 *     is the outstanding human step.
 */
export const ACCEPTED_MATCH_DELTAS: readonly AcceptedMatchDelta[] = [
	// ── coarse DIFF — genuine route-choice flips (NOT yet eyeballed) ────────────
	{
		date: "2026-06-28",
		hhmm: "10:35",
		coarse: "DIFF",
		path: "DIFF",
		note: "coarse 14v vs 13v, path 32v vs 28v",
		reason:
			"Route-choice flip: float and quant pick different corridors at a candidate-cost near-threshold. NOT yet visually reviewed — flagged for a before/after eyeball. Accepted on the display-only safety basis below, not on inspection.",
	},
	{
		date: "2026-06-29",
		hhmm: "08:43",
		coarse: "DIFF",
		path: "DIFF",
		note: "coarse 6v vs 5v, path 6v vs 5v",
		reason:
			"Route-choice flip: float and quant pick different corridors at a candidate-cost near-threshold. NOT yet visually reviewed — flagged for a before/after eyeball. Accepted on the display-only safety basis below, not on inspection.",
	},
	// ── coarse NEAR — same route, vertices within 30 cm ─────────────────────────
	{
		date: "2026-04-30",
		hhmm: "15:16",
		coarse: "NEAR",
		path: "DIFF",
		note: "coarse 4v vs 4v, path 17v vs 17v",
		reason: "Route near-tie: same drawn route, every vertex within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-05-22",
		hhmm: "14:14",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 16v vs 16v, path 56v vs 56v",
		reason: "Route near-tie: same drawn route, every vertex within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-06-16",
		hhmm: "16:07",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 12v vs 12v, path 42v vs 42v",
		reason: "Route near-tie: same drawn route, every vertex within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-06-28",
		hhmm: "11:17",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 22v vs 22v, path 51v vs 51v",
		reason: "Route near-tie: same drawn route, every vertex within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-07-02",
		hhmm: "14:36",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 23v vs 23v",
		reason: "Route near-tie: same drawn route, every vertex within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-07-06",
		hhmm: "10:34",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 36v vs 36v",
		reason: "Route near-tie: same drawn route, every vertex within 30 cm under float↔quant rounding. Display-only.",
	},
	// ── coarse EXACT, path DIFF — display-splice vertex near-ties ───────────────
	{
		date: "2026-05-11",
		hhmm: "19:59",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 27v vs 27v, path 75v vs 76v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by a vertex. Display-only.",
	},
	{
		date: "2026-06-09",
		hhmm: "17:45",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 9v vs 9v, path 40v vs 41v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by a vertex. Display-only.",
	},
	{
		date: "2026-06-16",
		hhmm: "15:48",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 41v vs 41v, path 97v vs 98v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by a vertex. Display-only.",
	},
	{
		date: "2026-07-12",
		hhmm: "14:02",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 21v vs 21v, path 58v vs 59v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by a vertex. Display-only.",
	},
	// ── coarse EXACT, path NEAR — spliced display curve within 30 cm ────────────
	{
		date: "2026-04-29",
		hhmm: "14:19",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 12v vs 12v, path 46v vs 46v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-04-29",
		hhmm: "14:50",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 32v vs 32v, path 66v vs 66v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-05-25",
		hhmm: "11:25",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 11v vs 11v, path 25v vs 25v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-06-15",
		hhmm: "16:41",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 9v vs 9v, path 62v vs 62v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-06-17",
		hhmm: "10:03",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 15v vs 15v, path 53v vs 53v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-07-02",
		hhmm: "07:45",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 11v vs 11v, path 32v vs 32v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-07-02",
		hhmm: "15:10",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 10v vs 10v, path 35v vs 35v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-07-17",
		hhmm: "09:31",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 12v vs 12v, path 42v vs 42v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-07-17",
		hhmm: "14:33",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 36v vs 36v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
];

const key = (date: string, hhmm: string): string => `${date}|${hhmm}`;
const accepted = new Map<string, AcceptedMatchDelta>(ACCEPTED_MATCH_DELTAS.map((d) => [key(d.date, d.hhmm), d]));

/**
 * True iff this measured leg divergence is in the accepted manifest — same
 * day+leg AND the same coarse/path classes AND the same note. A leg that flips
 * to a different class, or a leg not in the manifest at all, is NOT accepted.
 */
export function isAcceptedMatchDelta(
	date: string,
	hhmm: string,
	coarse: MatchLegClass,
	path: MatchLegClass,
	note: string,
): boolean {
	const d = accepted.get(key(date, hhmm));
	return d !== undefined && d.coarse === coarse && d.path === path && d.note === note;
}
