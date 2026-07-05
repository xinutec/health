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
 * This module classifies each ground-truth row into one of five verdicts by
 * combining its **status** (what is true) with its **provenance** (how much
 * to trust that claim — see {@link isEnforceableTruth}) and whether the
 * pipeline currently matches it:
 *
 *   - `verified`     — enforceable `correct` row, pipeline matches. Locked:
 *                      a later change away from this is a real regression.
 *   - `regressed`    — enforceable `correct` row, pipeline no longer matches.
 *                      A genuine failure (vs the blessed snapshot's blunt
 *                      "something changed").
 *   - `known-error`  — enforceable `wrong` row, pipeline still emits the
 *                      known-wrong value. Tolerated debt — counted, never
 *                      invisible, but not a failure.
 *   - `cleared`      — enforceable `wrong` row, pipeline no longer emits the
 *                      wrong value. The error got fixed; auto-acceptable.
 *   - `unverified`   — no enforceable truth for this row (partial/unclear
 *                      verdict, or inferred/unspecified provenance). The
 *                      snapshot still guards drift, but this is never
 *                      reported as proven-correct.
 *
 * Pure module. No DB, no IO, no globals. The caller owns the (format-fiddly)
 * job of expressing the live pipeline output for a row's window as a
 * {@link ParsedBlessed}; this module owns the verdict logic and the
 * field-level comparison.
 */

import { type GroundTruthRow, isEnforceableTruth, type ParsedBlessed } from "./ground-truth.js";

export type TruthVerdict = "verified" | "regressed" | "known-error" | "cleared" | "unverified";

/**
 * Render a live pipeline state into the {@link ParsedBlessed} comparison form,
 * so the same field-level comparator works on both sides. Mirrors the shapes
 * the blessed cells use:
 *   - stationary/sleeping → `@ Place (qualifier)`: split the trailing
 *     `(qualifier)` off the place name.
 *   - walking/driving/cycling → `on Way`: the way name as-is.
 *   - train → `From → To · Line` OR a bare line name. A state's train
 *     `wayName` renders as either a `A → B` route (optionally `· Line`) or
 *     just the line; parse whichever is present so train rows compare on
 *     board/alight when available and fall back to line-only otherwise.
 * Returns null for an absent state (no pipeline coverage for the window).
 */
export function parsePipelineState(
	state: { mode: string; place?: string | null; wayName?: string | null } | null,
): ParsedBlessed | null {
	if (state == null) return null;
	const mode = state.mode as ParsedBlessed["mode"];

	if (mode === "train") {
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
		// Bare line name (e.g. "Circle Line") — no board/alight available.
		return { mode, place: null, wayName: null, placeQualifier: null, trainFromTo: null, lineName: w || null };
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
 * Do two parsed cells describe the same state? Compares canonical mode plus
 * the attribution that defines the state: place for a stay, way for a move,
 * board/alight (+ line, when both name one) for a train. The trailing
 * `(qualifier)` is ignored — "HMC Westeinde (hospital)" and "HMC Westeinde"
 * are the same place; a wrong *qualifier* on a right place is a separate,
 * weaker signal, not a state mismatch. Either side null → not equivalent.
 */
export function blessedEquivalent(a: ParsedBlessed | null, b: ParsedBlessed | null): boolean {
	if (a == null || b == null) return false;
	if (canonicalMode(a.mode) !== canonicalMode(b.mode)) return false;

	if (a.mode === "train" || b.mode === "train") {
		const af = a.trainFromTo;
		const bf = b.trainFromTo;
		if (af == null || bf == null) return af == null && bf == null;
		if (norm(af.from) !== norm(bf.from) || norm(af.to) !== norm(bf.to)) return false;
		// Line only discriminates when BOTH cells name one — a missing line
		// is a partial attribution, not a contradiction.
		if (a.lineName != null && b.lineName != null && norm(a.lineName) !== norm(b.lineName)) return false;
		return true;
	}

	// Place beats way: if either side asserts a place, compare places.
	if (a.place != null || b.place != null) return norm(a.place) === norm(b.place);
	// Otherwise compare way attribution (both may be null — e.g. an
	// unlabelled walking sliver — which counts as equivalent).
	return norm(a.wayName) === norm(b.wayName);
}

/**
 * The verdict for a single row given whether the pipeline matches its blessed
 * cell. `pipelineMatchesBlessed` means the live output equals the row's
 * blessed-cell state (for a `correct` row that's the truth; for a `wrong` row
 * that's the *known-wrong* value the row rejects).
 */
export function rowVerdict(
	row: Pick<GroundTruthRow, "status" | "provenance">,
	pipelineMatchesBlessed: boolean,
): TruthVerdict {
	if (!isEnforceableTruth(row)) return "unverified";
	if (row.status === "correct") return pipelineMatchesBlessed ? "verified" : "regressed";
	// status === "wrong": the blessed cell is the value to reject.
	return pipelineMatchesBlessed ? "known-error" : "cleared";
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
 * {@link ParsedBlessed} (or null when no state covers the window). This
 * module compares it to the row's blessed cell and assigns the verdict.
 */
export function classifyDay(
	rows: readonly GroundTruthRow[],
	pipelineAt: (row: GroundTruthRow) => ParsedBlessed | null,
): DayTruthResult {
	const verdicts = rows.map((row) => {
		const matches = blessedEquivalent(row.blessed, pipelineAt(row));
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
