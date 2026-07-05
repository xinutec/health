/**
 * The grammar of a physically-possible day.
 *
 * This is the first load-bearing piece of the joint day-inference rebuild
 * (`docs/proposals/` — "infer the whole day jointly"). It formalises the HARD
 * laws a reconstructed day must obey — the ones whose violation is not "low
 * probability" but "impossible" — as a pure checker over the rendered
 * `DayState[]` timeline.
 *
 * It earns its keep three ways, all from this one definition:
 *   1. **Measurement.** Counting violations across the corpus is the objective
 *      the rebuild drives to zero — "how often does the pipeline emit a day
 *      that couldn't have happened?" (see `cli/score-constraints.ts`).
 *   2. **Grammar.** These same predicates become the zero-probability
 *      transitions of the joint decoder: a trajectory that violates one is
 *      never decoded, no matter how well each piece fits its sensors.
 *   3. **Critic.** A final pass can reject or flag any candidate day (cascade
 *      or decoder) that breaks a law — the "plausibility critic".
 *
 * Each law here is deliberately conservative: it fires only on a genuine
 * physical/resource impossibility, never on a merely-unusual day. Soft
 * implausibilities (a school as a 5-minute errand) belong in the probabilistic
 * scoring, not here.
 *
 * Pure; no DB, no IO.
 */

import type { DayState, DayStateMode } from "../sleep/day-state.js";

/** Modes in which the user is aboard a vehicle. Moving between two *different*
 *  vehicles requires alighting first — a non-vehicle state in between. */
const VEHICLE_MODES: ReadonlySet<DayStateMode> = new Set(["driving", "bus", "train", "cycling", "plane"]);

/** Station-pair / line separators as composed by the rail labeller
 *  (`passes/rail-reconcile.ts`): "Board → Alight · Line". */
const STATION_SEP = " → ";
const LINE_SEP = " · ";

/** Two states count as *contiguous* — back-to-back with no time to do anything
 *  between them — when the gap from one's end to the next's start is at most
 *  this. The adjacency laws only fire on contiguous pairs: a real gap (a GPS
 *  blackout, an overnight hole) is unobserved time during which the user could
 *  legitimately have travelled or alighted, so it is *incomplete*, not
 *  *impossible*. Flagging it would punish the honest "we didn't see this"
 *  rather than a genuine physics violation — the opposite of what we want. */
const CONTIGUITY_MAX_GAP_S = 120;

export type ConstraintId =
	/** Two adjacent vehicle legs of *different* modes with no non-vehicle state
	 *  between them — you cannot step from one moving vehicle straight into
	 *  another (the "drove along the tube line, then boarded the tube" shape). */
	| "vehicle-handoff"
	/** Two adjacent at-rest states at *different* named places with no
	 *  travelling state between them — you cannot teleport between places. */
	| "stay-teleport"
	/** A rail/bus leg whose board and alight stations are the same — a journey
	 *  that begins and ends at one stop is not a journey. */
	| "transit-same-endpoint";

export interface Violation {
	constraint: ConstraintId;
	/** Index of the offending state (the first of the pair for adjacency laws). */
	index: number;
	detail: string;
}

const REST_MODES: ReadonlySet<DayStateMode> = new Set(["stationary", "sleeping"]);

/** Parse a moving leg's "Board → Alight · Line" label into its endpoints, or
 *  null when the label is not a station-pair (a road name, a bare way, absent). */
export function parseStationPair(wayName: string | undefined): { board: string; alight: string } | null {
	if (!wayName?.includes(STATION_SEP)) return null;
	const [board, rest] = wayName.split(STATION_SEP, 2);
	const alight = rest.split(LINE_SEP, 1)[0];
	if (!board || !alight) return null;
	return { board: board.trim(), alight: alight.trim() };
}

/**
 * Every hard-constraint violation in a rendered day, in timeline order. An
 * empty array means the day is physically possible (it may still be *wrong* —
 * that is the probabilistic layer's job — but not impossible).
 */
export function checkDayConstraints(states: readonly DayState[]): Violation[] {
	const violations: Violation[] = [];

	for (let i = 0; i < states.length; i++) {
		const s = states[i];

		// Law 3 — a transit leg must run between two distinct stations.
		if (s.mode === "train" || s.mode === "bus") {
			const pair = parseStationPair(s.wayName);
			if (pair && pair.board === pair.alight) {
				violations.push({
					constraint: "transit-same-endpoint",
					index: i,
					detail: `${s.mode} leg boards and alights at "${pair.board}"`,
				});
			}
		}

		const next = states[i + 1];
		if (!next) continue;
		// Adjacency laws apply only to contiguous pairs — a real gap is
		// unobserved time the user could have travelled/alighted in.
		if (next.startTs - s.endTs > CONTIGUITY_MAX_GAP_S) continue;

		// Law 1 — no direct hand-off between two different vehicles.
		if (VEHICLE_MODES.has(s.mode) && VEHICLE_MODES.has(next.mode) && s.mode !== next.mode) {
			violations.push({
				constraint: "vehicle-handoff",
				index: i,
				detail: `${s.mode} → ${next.mode} with no alighting (walk/stop) between`,
			});
		}

		// Law 2 — no teleport between two distinct at-rest places.
		if (REST_MODES.has(s.mode) && REST_MODES.has(next.mode) && s.place && next.place && s.place !== next.place) {
			violations.push({
				constraint: "stay-teleport",
				index: i,
				detail: `at "${s.place}" then "${next.place}" with no travel between`,
			});
		}
	}

	return violations;
}
