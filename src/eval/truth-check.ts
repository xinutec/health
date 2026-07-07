/**
 * Three-way truth check — the enforcement layer over the provenance model.
 *
 * The golden harness diffs pipeline output against the last *blessed
 * snapshot*, which conflates three very different things into one
 * "must-not-change" blob: lines we have *confirmed true*, lines we *know are
 * wrong but tolerate*, and lines *nobody ever checked*. So fixing a known
 * error trips the harness exactly like causing a regression, and an
 * unverified line is treated as gospel.
 *
 * This module classifies each ground-truth row into one of five verdicts.
 * A row's cell states the TRUTH (what actually happened — see
 * `ground-truth.ts`); its **status** says how the pipeline relates to that
 * truth; its **provenance** says how much to trust the claim (see
 * {@link isEnforceableTruth}); and the live comparison says whether the
 * pipeline currently matches it:
 *
 *   - `verified`     — enforceable `correct` row, pipeline matches the
 *                      truth. Locked: a later change away from this is a
 *                      real regression.
 *   - `regressed`    — enforceable `correct` row, pipeline no longer
 *                      matches the truth. A genuine failure (vs the blessed
 *                      snapshot's blunt "something changed").
 *   - `known-error`  — enforceable `wrong` row, pipeline still deviates
 *                      from the truth. Tolerated debt — counted, never
 *                      invisible, but not a failure.
 *   - `cleared`      — enforceable `wrong` row, pipeline now MATCHES the
 *                      truth. The deviation got fixed — and verifiably so,
 *                      not merely "the output changed"; flip the row to
 *                      `correct` to lock it in.
 *   - `unverified`   — no enforceable truth for this row (partial/unclear
 *                      verdict, or inferred/unspecified provenance). The
 *                      snapshot still guards drift, but this is never
 *                      reported as proven-correct.
 *
 * Pure module. No DB, no IO, no globals. The caller owns the (format-fiddly)
 * job of expressing the live pipeline output for a row's window as a
 * {@link ParsedTruth}; this module owns the verdict logic and the
 * field-level comparison.
 */

import { type GroundTruthRow, isEnforceableTruth, type ParsedTruth } from "./ground-truth.js";

export type TruthVerdict = "verified" | "regressed" | "known-error" | "cleared" | "unverified";

/**
 * Render a live pipeline state into the {@link ParsedTruth} comparison form,
 * so the same field-level comparator works on both sides. Mirrors the shapes
 * the truth cells use:
 *   - stationary/sleeping → `@ Place (qualifier)`: split the trailing
 *     `(qualifier)` off the place name.
 *   - walking/driving/cycling → `on Way`: the way name as-is.
 *   - train/bus → `From → To · Line` OR a bare line name. A transit state's
 *     `wayName` renders as either an `A → B` route (optionally `· Line`) or
 *     just the line (train) / the road names (bus) — parse whichever is
 *     present so transit rows compare on board/alight when available and
 *     fall back to line/way otherwise.
 * Returns null for an absent state (no pipeline coverage for the window).
 */
export function parsePipelineState(
	state: { mode: string; place?: string | null; wayName?: string | null } | null,
): ParsedTruth | null {
	if (state == null) return null;
	const mode = state.mode as ParsedTruth["mode"];

	if (mode === "train" || mode === "bus") {
		const w = state.wayName?.trim() ?? "";
		const route = /^(.+?)\s+→\s+([^·]+?)(?:\s*·\s*(.+))?$/.exec(w);
		if (route) {
			return {
				mode,
				place: null,
				wayName: null,
				placeQualifier: null,
				trainFromTo: { from: route[1].trim(), to: route[2].trim() },
				lineName: route[3]?.trim() ?? null,
			};
		}
		if (mode === "train") {
			// Bare line name (e.g. "Circle Line") — no board/alight available.
			return { mode, place: null, wayName: null, placeQualifier: null, trainFromTo: null, lineName: w || null };
		}
		// A routeless bus label is road names ("Fifth Way, Edgware Road").
		return { mode, place: null, wayName: w || null, placeQualifier: null, trainFromTo: null, lineName: null };
	}

	if (state.place != null) {
		const pm = /^(.+?)(?:\s+\(([^)]+)\))?$/.exec(state.place.trim());
		return {
			mode,
			place: pm ? pm[1].trim() : state.place.trim(),
			wayName: null,
			placeQualifier: pm?.[2]?.trim() ?? null,
			trainFromTo: null,
			lineName: null,
		};
	}

	return {
		mode,
		place: null,
		wayName: state.wayName?.trim() ?? null,
		placeQualifier: null,
		trainFromTo: null,
		lineName: null,
	};
}

/** Sleeping and stationary are the same canonical class — the pipeline emits
 *  `sleeping` for in-bed minutes where a decoder might say `stationary`. */
function canonicalMode(m: string): string {
	return m === "sleeping" ? "stationary" : m;
}

function norm(s: string | null): string | null {
	return s == null ? null : s.trim().toLowerCase();
}

/**
 * Does the live state match the truth cell? DELIBERATELY ASYMMETRIC: the
 * truth cell asserts only what it names, so extra attribution on the live
 * side is not a contradiction — a truth of plain "walking" is satisfied by
 * "walking on Barn Rise" (the narrative only vetted the mode), and a truth
 * of "train A → B" without a `· Line` is satisfied by any line. But every
 * assertion the truth DOES make must hold: a named place, way, or
 * board/alight pair that the live side lacks or contradicts is a mismatch.
 * The trailing `(qualifier)` is ignored — "HMC Westeinde (hospital)" and
 * "HMC Westeinde" are the same place; a wrong *qualifier* on a right place
 * is a separate, weaker signal, not a state mismatch. A null truth (unparsed
 * cell) or absent live state never matches.
 */
export function truthMatches(truth: ParsedTruth | null, live: ParsedTruth | null): boolean {
	if (truth == null || live == null) return false;
	if (canonicalMode(truth.mode) !== canonicalMode(live.mode)) return false;

	if (truth.mode === "train" || truth.mode === "bus") {
		if (truth.trainFromTo != null) {
			if (live.trainFromTo == null) return false;
			if (
				norm(truth.trainFromTo.from) !== norm(live.trainFromTo.from) ||
				norm(truth.trainFromTo.to) !== norm(live.trainFromTo.to)
			)
				return false;
		}
		// Line/route only discriminates when BOTH sides name one — a missing
		// line is a partial attribution, not a contradiction.
		if (truth.lineName != null && live.lineName != null && norm(truth.lineName) !== norm(live.lineName)) return false;
		// A truth-asserted road for a bus ("bus on Piccadilly") must hold.
		if (truth.wayName != null && norm(truth.wayName) !== norm(live.wayName)) return false;
		return true;
	}

	// A truth-asserted place must match; a truth-asserted way must match; a
	// truth that asserts neither is a mode-only claim.
	if (truth.place != null) return norm(truth.place) === norm(live.place);
	if (truth.wayName != null) return norm(truth.wayName) === norm(live.wayName);
	return true;
}

/**
 * The verdict for a single row given whether the live pipeline output
 * matches the row's truth cell.
 */
export function rowVerdict(
	row: Pick<GroundTruthRow, "status" | "provenance">,
	pipelineMatchesTruth: boolean,
): TruthVerdict {
	if (!isEnforceableTruth(row)) return "unverified";
	if (row.status === "correct") return pipelineMatchesTruth ? "verified" : "regressed";
	// status === "wrong": a known deviation from the truth in the cell —
	// matching the truth means it got fixed.
	return pipelineMatchesTruth ? "cleared" : "known-error";
}

export interface DayTruthResult {
	verdicts: Array<{ row: GroundTruthRow; verdict: TruthVerdict }>;
	verified: number;
	regressed: number;
	knownError: number;
	cleared: number;
	unverified: number;
	/** True iff any enforceable `correct` row no longer matches — the only
	 *  verdict class that should fail a check. */
	hasRegression: boolean;
}

/**
 * Classify every row of a day. The caller supplies `pipelineAt(row)` — the
 * live pipeline's output for that row's window, expressed as a
 * {@link ParsedTruth} (or null when no state covers the window). This
 * module compares it to the row's truth cell and assigns the verdict.
 */
export function classifyDay(
	rows: readonly GroundTruthRow[],
	pipelineAt: (row: GroundTruthRow) => ParsedTruth | null,
): DayTruthResult {
	const verdicts = rows.map((row) => {
		const matches = truthMatches(row.truth, pipelineAt(row));
		return { row, verdict: rowVerdict(row, matches) };
	});
	const count = (v: TruthVerdict) => verdicts.filter((x) => x.verdict === v).length;
	return {
		verdicts,
		verified: count("verified"),
		regressed: count("regressed"),
		knownError: count("known-error"),
		cleared: count("cleared"),
		unverified: count("unverified"),
		hasRegression: verdicts.some((x) => x.verdict === "regressed"),
	};
}
