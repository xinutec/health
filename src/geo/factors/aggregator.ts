/**
 * Factor aggregator.
 *
 * Pure function: given a list of candidates, a context, and a list
 * of factors, runs each factor against each candidate and returns a
 * ScoredRefinement (best + alternatives + margin).
 *
 * Design notes:
 *
 *   - Factors that return null are dropped from the candidate's
 *     `factors` breakdown — they contribute 0 to the total, AND they
 *     don't show up as "(no rationale)" entries in the eventual UI.
 *     This matters because "no biometric signature for this mode" is
 *     genuinely different from "biometric evidence against this mode."
 *   - Ranking is stable: ties are broken by input order, so the
 *     consumer can pre-sort candidates in a meaningful order (e.g.
 *     by geographical relevance) and have that order respected.
 *   - The aggregator does NO candidate generation. The consumer
 *     supplies candidates; the aggregator scores. Generators live
 *     elsewhere (each rule the current cascade replaces will get its
 *     own generator co-located with the cutover code).
 *   - Empty candidate list is a programming error, not an empty
 *     output — throws.
 *
 * Forward-load-bearing for two things:
 *
 *   1. The Phase 1 cutover in `refineMode`: refineMode produces
 *      candidates, calls scoreCandidates, returns the ScoredRefinement
 *      instead of today's flat (mode, confidence, reason, wayName).
 *   2. The Phase 3 explanation UI: the panel reads
 *      `EnrichedSegment.factorBreakdown: ScoredRefinement` and
 *      renders best + alternatives + their factor scores.
 */

import type { Factor, FactorContext, ModeCandidate, ScoredCandidate, ScoredRefinement } from "./types.js";

/**
 * Run every factor against every candidate, sum non-null scores per
 * candidate, return the ranked result.
 *
 * @throws if candidates is empty
 */
export function scoreCandidates(
	candidates: readonly ModeCandidate[],
	ctx: FactorContext,
	factors: readonly Factor[],
): ScoredRefinement {
	if (candidates.length === 0) {
		throw new Error("scoreCandidates: must supply at least one candidate");
	}
	const scored: ScoredCandidate[] = candidates.map((c) => {
		const contributions = factors.map((f) => f(c, ctx)).filter((s) => s !== null);
		const totalScore = contributions.reduce((acc, s) => acc + s.score, 0);
		return { ...c, factors: contributions, totalScore };
	});

	// Primary: total log-posterior, descending. Secondary tie-break:
	// prefer a candidate carrying a `wayName` over one that doesn't.
	// Two candidates with identical scores but one with a labelled way
	// and one without (e.g. an unnamed footway segment overlapping a
	// named "Queen's Walk" footpath, both at the same minimum distance)
	// should resolve to the labelled one — it's a more specific
	// feature, and the rendered timeline depends on it for human
	// readability. The 2026-05-23 backtest of the factored refineMode
	// surfaced this as the residual cause of walking-segment wayName
	// loss after way-presence was added — the bonus broke the tie
	// vs. the no-way fallback, but not vs. an unnamed sibling way.
	// On all-equal-or-all-unlabelled ties, Array.prototype.sort's
	// ECMAScript-spec stability keeps the input order.
	const ranked = [...scored].sort((a, b) => {
		const byScore = b.totalScore - a.totalScore;
		if (byScore !== 0) return byScore;
		const aHasName = a.wayName ? 1 : 0;
		const bHasName = b.wayName ? 1 : 0;
		return bHasName - aHasName;
	});

	const best = ranked[0];
	const alternatives = ranked.slice(1);
	const margin = alternatives.length === 0 ? Number.POSITIVE_INFINITY : best.totalScore - alternatives[0].totalScore;

	return { best, alternatives, margin };
}
