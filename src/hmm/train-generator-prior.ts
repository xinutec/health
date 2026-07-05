/**
 * Train-generator soft prior — Phase 1 of `docs/proposals/
 * decoder-roadmap.md` (see also `decoder-roadmap.md`).
 *
 * Turns the structural `(board, line, alight)` candidates from
 * `enumerateTrainCandidates` into a **per-segment entry prior** over
 * `train @ L` states, plus a coverage predicate that gates the per-minute
 * line factors off where this prior is authoritative.
 *
 * Why an *entry* prior (once per segment), not a per-minute emission:
 * a train segment's line is one commitment for the whole ride, and the
 * decode splits a segment wherever the per-minute line changes — so a
 * per-minute boost could flip lines mid-ride. The line decision belongs
 * at the segment boundary.
 *
 * Why *soft* (a calibrated nat, not ±∞): the generator needs a station
 * within ~250 m of the board/alight GPS context, which sparse post-tube
 * GPS can miss for a *real* ride. A hard filter would zero that real
 * train out; the soft prior strongly favours valid triples and never
 * forbids a train the generator missed (those minutes fall through to the
 * per-minute factors, which stay live off-window).
 *
 * Pure module. No DB, no IO, no globals.
 */

import type { RouteGraph } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";
import { enumerateTrainCandidates, type TrainCandidate } from "./train-candidate-generator.js";

/** Entry boost for a `train @ L` segment whose line is structurally valid
 *  for the covered window. Small and positive — the generator's "this is
 *  a real station-to-station ride on L" is genuine evidence *for* train,
 *  but a single-fire entry term, kept modest so it nudges rather than
 *  forces mode. Anchored below the ~5-nat cross-state transition cost. */
const VALID_LINE_BOOST = 3;

/** Entry penalty for a `train @ L` segment whose line is *not* valid for
 *  the covered window (e.g. a Met train "to Green Park" — no Met station
 *  there). Decisive among train lines (on covered minutes the per-minute
 *  line factors are gated off, so this is the only line signal), but
 *  bounded so it overcomes line-inertia without flipping the mode to
 *  driving. */
const INVALID_LINE_PENALTY = 8;

export interface TrainGeneratorPrior {
	/** Per-segment entry log-prior over `train @ L` states. Composes
	 *  additively with the existing `entryLogProb`. */
	entry: (state: State, obs: Observation) => number;
	/** True when the minute at `ts` falls inside a generator train window.
	 *  Passed to the per-minute line factors so they yield to this prior on
	 *  covered minutes (no double-counting). */
	isCovered: (ts: number) => boolean;
}

/**
 * Build the entry prior + coverage from an already-enumerated candidate
 * set. Split out from `buildTrainGeneratorPrior` so the coverage/entry
 * logic is unit-testable without a synthetic route graph.
 *
 * `candidates[i].startMin/endMin` are indices into `observations`; the
 * coverage map is keyed by `observations[m].ts` (unique per the contiguous
 * minute tensor). Generator windows are disjoint, so every covered minute
 * belongs to exactly one window — the lines accumulated at a `ts` are all
 * valid for that single window (multiple `(board, alight)` pairs on
 * different lines), never a union across distinct windows.
 */
export function buildTrainEntryFromCandidates(
	candidates: readonly TrainCandidate[],
	observations: readonly Observation[],
): TrainGeneratorPrior {
	const coverage = new Map<number, Set<string>>();
	for (const c of candidates) {
		for (let m = c.startMin; m <= c.endMin; m++) {
			const ob = observations[m];
			if (ob === undefined) continue;
			let lines = coverage.get(ob.ts);
			if (lines === undefined) {
				lines = new Set<string>();
				coverage.set(ob.ts, lines);
			}
			lines.add(c.line);
		}
	}

	const entry = (state: State, obs: Observation): number => {
		if (state.mode !== "train") return 0;
		// `unknown_rail` is the graceful-degradation fallback — the generator
		// never emits it, so it would always read "invalid"; never penalise it.
		if (state.lineName === null || state.lineName === "unknown_rail") return 0;
		const lines = coverage.get(obs.ts);
		if (lines === undefined) return 0; // generator silent here
		return lines.has(state.lineName) ? VALID_LINE_BOOST : -INVALID_LINE_PENALTY;
	};

	return { entry, isCovered: (ts: number) => coverage.has(ts) };
}

/** Enumerate train candidates from the route graph and build the prior. */
export function buildTrainGeneratorPrior(opts: {
	observations: readonly Observation[];
	routeGraph: RouteGraph;
	knownLines: readonly string[];
}): TrainGeneratorPrior {
	const candidates = enumerateTrainCandidates({
		observations: opts.observations,
		routeGraph: opts.routeGraph,
		knownLines: opts.knownLines,
	});
	return buildTrainEntryFromCandidates(candidates, opts.observations);
}
