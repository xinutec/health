/**
 * Journey-correctness ratchet gate — the measurement foundation the
 * decoder-owns-mode program (#257, #250) stands on.
 *
 * `npm run golden` gates on the fixture snapshot diff and worldline-feasibility,
 * but the truth layer (does the reconstructed day read as the right sequence of
 * trips?) was informational only — the golden PASSED while 20+ confirmed tube
 * journeys were silently mis-reconstructed. You cannot build a joint mode+position
 * model against a gate that is blind to the thing it is meant to fix.
 *
 * This is the ratchet: a committed baseline records WHICH ground-truth journeys
 * the pipeline currently reconstructs correctly (by their narrative-stable start
 * time). The gate then fails when a previously-correct journey breaks — mirroring
 * `worldline-feasibility`, except the baseline is the current (non-zero) set of
 * working journeys instead of zero, because most journeys are not yet correct.
 * Standing failures are recorded, visible, and can only shrink; a fix is surfaced
 * as an improvement to re-bless into the baseline. Pure: no IO.
 *
 * The mechanism is generic — a one-way floor over per-day key sets — and is
 * shared with the truth-row ratchet; see `floor-gate.ts`. This module is the
 * journey-shaped name for it.
 */

import { type FloorBaseline, type FloorGateResult, gateFloor } from "./floor-gate.js";

/** Per-date set of ground-truth journey start times (unix seconds) the pipeline
 *  reconstructs with the correct mode shape. The committed floor. */
export type JourneyBaseline = FloorBaseline;

export type JourneyGateResult = FloorGateResult;

/**
 * Compare the baseline against the current run. A regression is a `(date,
 * startTs)` in the baseline that is absent from `current` — a journey that used
 * to be reconstructed correctly and now is not. An improvement is the reverse.
 * `current` maps each date to the set of GT-journey start times that matched
 * this run.
 */
export const gateJourneys = gateFloor;
