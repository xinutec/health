/**
 * Worldline-feasibility invariants — Phase 0 of
 * `docs/proposals/decoder-roadmap.md`.
 *
 * A model-independent assertion on the *output* timeline: a real worldline is
 * one continuous path through space-time, so some outputs are simply
 * impossible regardless of how the cascade produced them. This module checks
 * the impossibilities the pipeline has actually emitted, on the final
 * `DayState`-shaped legs, with no dependency on the model that built them.
 *
 * Invariants (rail, the class behind the 2026-06-22 bug):
 *
 *   - **Rail continuity.** Two train legs with no *relocating* travel between
 *     them (only stationary / sleeping, or nothing) must share a station —
 *     `alight(prev) == board(next)`. You cannot step off a train at one
 *     station and instantly board at a different one. (A walking/driving leg
 *     between them legitimately relocates you, so no assertion is made there.)
 *   - **No self-ride.** A train leg cannot board and alight at the same
 *     station.
 *
 * Deliberately conservative: it only asserts when the station pair is
 * *determinable* (a parseable `Board → Alight` `wayName`). A bare-line train
 * leg carries no pair to chain on, so it breaks the chain rather than
 * producing a false positive. This keeps the check zero-false-positive — every
 * violation it reports is a genuine physical impossibility.
 *
 * This is the regression baseline + standing gate for the journey-worldline
 * migration: the heuristic cascade enforces continuity by *repair*
 * (`reconcileAdjacentRailLegs`, a `wayName`-string rewrite that the
 * 2026-06-22 bug slipped past); this is the independent *verification* of the
 * result. The worldline model (Phase 3) makes continuity structural and
 * renders this redundant — until then it is the gate.
 *
 * Pure module. No DB, no IO, no globals.
 */

import { parseRailWayName } from "../geo/passes/rail-reconcile.js";

export type FeasibilityViolationKind = "rail-discontinuity" | "degenerate-train-leg";

export interface FeasibilityViolation {
	kind: FeasibilityViolationKind;
	/** The offending (later) leg's window, for reporting. */
	startTs: number;
	endTs: number;
	/** Human-readable explanation. */
	detail: string;
}

/** The minimal timeline-leg shape this check needs — structurally a
 *  `DayState` (`startTs`, `endTs`, `mode`, optional train `wayName`). Kept
 *  local so the eval layer doesn't depend on the sleep/day-state module. */
export interface FeasibilityLeg {
	startTs: number;
	endTs: number;
	mode: string;
	wayName?: string;
}

/** Modes that do NOT move the user between distinct stations. A stay or sleep
 *  between two train legs cannot put you at a different boarding station; a
 *  walking/driving/cycling leg can. */
const NON_RELOCATING: ReadonlySet<string> = new Set(["stationary", "sleeping", "unknown"]);

export function checkWorldlineFeasibility(legs: readonly FeasibilityLeg[]): FeasibilityViolation[] {
	const violations: FeasibilityViolation[] = [];

	// The station the previous train leg alighted at, when determinable, and
	// whether a relocating leg has occurred since (which severs the continuity
	// requirement — you could have walked to a new station).
	let prevAlight: string | null = null;
	let relocatedSincePrevTrain = false;

	for (const l of legs) {
		if (l.mode === "train") {
			const rail = parseRailWayName(l.wayName);
			const board = rail?.board ?? null;
			const alight = rail?.alight ?? null;

			// No-self-ride: a single leg from a station to itself.
			if (board !== null && alight !== null && board === alight) {
				violations.push({
					kind: "degenerate-train-leg",
					startTs: l.startTs,
					endTs: l.endTs,
					detail: `train boards and alights at the same station (${board})`,
				});
			}

			// Continuity: assert only when we have both endpoints and nothing
			// relocated the user since the previous train.
			if (prevAlight !== null && !relocatedSincePrevTrain && board !== null && board !== prevAlight) {
				violations.push({
					kind: "rail-discontinuity",
					startTs: l.startTs,
					endTs: l.endTs,
					detail: `train boards at ${board} but the previous train alighted at ${prevAlight} with no travel between`,
				});
			}

			// Advance the chain. If this leg has no determinable alight, the
			// chain is broken (we can't assert across it).
			prevAlight = alight;
			relocatedSincePrevTrain = false;
		} else if (!NON_RELOCATING.has(l.mode)) {
			// walking / driving / cycling / plane — relocates the user.
			relocatedSincePrevTrain = true;
		}
		// stationary / sleeping / unknown: leave the chain intact.
	}

	return violations;
}
