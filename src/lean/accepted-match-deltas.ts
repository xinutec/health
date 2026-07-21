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
 * agree 173/173), so serving Lean == serving the quant twin. These float↔quant
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
 * Measured on the 31-day golden corpus (2026-07-21, `npm run compare-match
 * -- --gate`): 173 legs, quant↔Lean 173/173 bit-EXACT, 21 float↔quant deltas.
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
 *   - coarse DIFF (3): genuine route-choice flips at a cost near-threshold.
 *     06-28 10:35 is the largest (a visibly shorter drawn route) and is flagged
 *     for a visual eyeball; the other two are ±1 vertex / a building-penalty
 *     in-vs-out edge.
 */
export const ACCEPTED_MATCH_DELTAS: readonly AcceptedMatchDelta[] = [
	// ── coarse DIFF — genuine route-choice flips (display-only) ──────────────
	{
		date: "2026-06-23",
		hhmm: "08:16",
		coarse: "DIFF",
		path: "DIFF",
		note: "coarse 8v vs 9v, path 8v vs 9v",
		reason:
			"Route-choice flip: quant routes one extra corner vertex (8→9) at a candidate-cost near-threshold. Display-only; quant↔Lean bit-exact.",
	},
	{
		date: "2026-06-28",
		hhmm: "10:35",
		coarse: "DIFF",
		path: "DIFF",
		note: "coarse 14v vs 11v, path 33v vs 25v",
		reason:
			"Largest divergence — quant selects a shorter drawn route (14→11 coarse / 33→25 path vertices) at a routing near-threshold, not a coordinate near-tie. Display-only (walkMatchedPath never feeds the decode); quant↔Lean bit-exact. FLAGGED for a visual before/after eyeball.",
	},
	{
		date: "2026-07-07",
		hhmm: "08:42",
		coarse: "DIFF",
		path: "DIFF",
		note: "coarse 28v vs 28v, path 63v vs 62v",
		reason:
			"Building-penalty in/out flip: same vertex count, a through-building vs detour edge lands either side of the unsupported-crossing cost under float vs quant. Display-only; quant↔Lean bit-exact.",
	},
	// ── coarse NEAR — same route, vertices within 30 cm ──────────────────────
	{
		date: "2026-04-29",
		hhmm: "15:52",
		coarse: "NEAR",
		path: "DIFF",
		note: "coarse 7v vs 7v, path 12v vs 11v",
		reason: "Route near-tie (coarse ≤30 cm) with a one-vertex display-splice near-tie. Display-only.",
	},
	{
		date: "2026-05-22",
		hhmm: "14:14",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 16v vs 16v, path 62v vs 62v",
		reason: "Route near-tie: same drawn route, all vertices within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-06-16",
		hhmm: "16:07",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 13v vs 13v, path 45v vs 45v",
		reason: "Route near-tie: same drawn route, all vertices within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-06-28",
		hhmm: "11:17",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 26v vs 26v, path 45v vs 45v",
		reason: "Route near-tie: same drawn route, all vertices within 30 cm under float↔quant rounding. Display-only.",
	},
	{
		date: "2026-07-06",
		hhmm: "10:34",
		coarse: "NEAR",
		path: "NEAR",
		note: "coarse 19v vs 19v, path 53v vs 53v",
		reason: "Route near-tie: same drawn route, all vertices within 30 cm under float↔quant rounding. Display-only.",
	},
	// ── coarse EXACT, path DIFF — display-splice vertex near-ties ─────────────
	{
		date: "2026-04-30",
		hhmm: "15:16",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 4v vs 4v, path 18v vs 18v",
		reason:
			"Display-splice near-tie: identical route decision; a spliced curve vertex shifts >30 cm at a splice near-tie. Display-only.",
	},
	{
		date: "2026-05-11",
		hhmm: "19:59",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 27v vs 27v, path 69v vs 70v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by one vertex. Display-only.",
	},
	{
		date: "2026-05-12",
		hhmm: "12:49",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 11v vs 11v, path 40v vs 39v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by one vertex. Display-only.",
	},
	{
		date: "2026-06-09",
		hhmm: "17:45",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 9v vs 9v, path 40v vs 41v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by one vertex. Display-only.",
	},
	{
		date: "2026-06-17",
		hhmm: "10:03",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 17v vs 17v, path 57v vs 58v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by one vertex. Display-only.",
	},
	{
		date: "2026-06-28",
		hhmm: "09:12",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 7v vs 7v, path 14v vs 12v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by two vertices. Display-only.",
	},
	{
		date: "2026-07-12",
		hhmm: "14:02",
		coarse: "EXACT",
		path: "DIFF",
		note: "coarse 22v vs 22v, path 57v vs 58v",
		reason:
			"Display-splice near-tie: identical route decision; the spliced display line differs by one vertex. Display-only.",
	},
	// ── coarse EXACT, path NEAR — spliced display curve within 30 cm ──────────
	{
		date: "2026-04-29",
		hhmm: "14:19",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 12v vs 12v, path 46v vs 46v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-05-25",
		hhmm: "11:25",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 10v vs 10v, path 24v vs 24v",
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
		date: "2026-06-23",
		hhmm: "10:12",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 6v vs 6v, path 9v vs 9v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-07-02",
		hhmm: "07:45",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 10v vs 10v, path 36v vs 36v",
		reason: "Display-splice near-tie: identical route decision, spliced display curve within 30 cm. Display-only.",
	},
	{
		date: "2026-07-02",
		hhmm: "15:10",
		coarse: "EXACT",
		path: "NEAR",
		note: "coarse 12v vs 12v, path 41v vs 41v",
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
