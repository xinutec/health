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

export type FeasibilityViolationKind = "rail-discontinuity" | "degenerate-train-leg" | "impossible-mode-kinematics";

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

/** A time-stamped position — the minimal fix shape the kinematic invariant
 *  needs. Structurally a subset of `FilteredPoint`. */
export interface FeasibilityFix {
	ts: number;
	lat: number;
	lon: number;
}

/** Per-step pace above which a fix pair is vehicle motion, not on-foot motion.
 *  The physical walking ceiling is 12 km/h (constraint C2,
 *  `MAX_SPEED_FOR_MODE.walking`); 15 gives the same GPS-noise headroom the
 *  vehicle-carve and alight-anchor passes use (`VEHICLE_LEG_MOVE_KMH`,
 *  `ALIGHT_HOP_MIN_KMH`). */
const KINEMATIC_VEHICLE_STEP_KMH = 15;
/** A vehicle-paced run only counts as impossible when it actually travels an
 *  inter-station-scale distance. Matches `ALIGHT_HOP_MIN_DIST_M` /
 *  `VEHICLE_LEG_MIN_DIST_M`'s order of magnitude; jitter cannot accumulate
 *  this as NET displacement. */
const KINEMATIC_MIN_RUN_NET_M = 250;
/** …across at least this many consecutive fast steps. A single fast step is a
 *  GPS reacquire teleport (handled by spike rejection), not evidence of a
 *  ride; two or more mutually-consistent fast steps are. Deliberately
 *  insensitive to single-jump blackout hops — those are the alight/boarding
 *  anchors' job; this invariant is the backstop for sustained evidence. */
const KINEMATIC_MIN_RUN_STEPS = 2;

const EARTH_R_M = 6_371_000;
function fixDistanceM(a: FeasibilityFix, b: FeasibilityFix): number {
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLon = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
	return Math.sqrt(dLat * dLat + dLon * dLon) * EARTH_R_M;
}

/** Modes whose legs the kinematic invariant asserts on, with the pace that is
 *  impossible for them. Walking only, deliberately: a stationary leg's sparse
 *  blackout fixes can teleport in consistent pairs (cell-tower hops), so
 *  asserting there would not be zero-false-positive yet. */
const KINEMATIC_ASSERTED_MODES: ReadonlySet<string> = new Set(["walking"]);

/**
 * A `walking` leg whose fixes sustain a vehicle-paced run over a real
 * distance contains movement that is not walking — a ride tail stranded by a
 * mis-placed segment boundary (the class behind the "64 km/h walk down the
 * rail corridor"). The run test mirrors the alight-anchor's settle scan:
 * contiguous steps at vehicle pace, qualified by the run's NET displacement
 * (jitter can be fast per-step but goes nowhere) and by run length (a single
 * fast step is a reacquire teleport, not a ride).
 */
function checkModeKinematics(
	legs: readonly FeasibilityLeg[],
	points: readonly FeasibilityFix[],
): FeasibilityViolation[] {
	const violations: FeasibilityViolation[] = [];
	for (const l of legs) {
		if (!KINEMATIC_ASSERTED_MODES.has(l.mode)) continue;
		const fixes = points.filter((p) => p.ts >= l.startTs && p.ts <= l.endTs);
		let runStart = -1;
		let runSteps = 0;
		let worst: { netM: number; steps: number; peakKmh: number } | null = null;
		let peakKmh = 0;
		for (let i = 1; i < fixes.length; i++) {
			const dt = fixes[i].ts - fixes[i - 1].ts;
			const stepM = fixDistanceM(fixes[i - 1], fixes[i]);
			const stepKmh = dt > 0 ? (stepM / dt) * 3.6 : 0;
			if (stepKmh >= KINEMATIC_VEHICLE_STEP_KMH) {
				if (runStart < 0) {
					runStart = i - 1;
					runSteps = 0;
					peakKmh = 0;
				}
				runSteps++;
				peakKmh = Math.max(peakKmh, stepKmh);
				const netM = fixDistanceM(fixes[runStart], fixes[i]);
				if (runSteps >= KINEMATIC_MIN_RUN_STEPS && netM >= KINEMATIC_MIN_RUN_NET_M && (!worst || netM > worst.netM)) {
					worst = { netM, steps: runSteps, peakKmh };
				}
			} else {
				runStart = -1;
			}
		}
		if (worst) {
			violations.push({
				kind: "impossible-mode-kinematics",
				startTs: l.startTs,
				endTs: l.endTs,
				detail:
					`${l.mode} leg sustains a vehicle-paced run: ${Math.round(worst.netM)} m net over ` +
					`${worst.steps} consecutive fast steps (peak ${Math.round(worst.peakKmh)} km/h) — ` +
					`not physically ${l.mode}`,
			});
		}
	}
	return violations;
}

export function checkWorldlineFeasibility(
	legs: readonly FeasibilityLeg[],
	points?: readonly FeasibilityFix[],
): FeasibilityViolation[] {
	const violations: FeasibilityViolation[] = points ? checkModeKinematics(legs, points) : [];

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
