/**
 * Journey-level scorer — the cutover gate the decoder-owns-mode program
 * depends on (`docs/proposals/decoder-roadmap.md`, measurement phase).
 *
 * `score-day.ts` scores per minute: it is brittle to a few minutes of
 * boundary misalignment (a train leg the decoder places at 15:35–15:38
 * against a ground-truth 15:30–15:38 scores most minutes wrong even when
 * the *leg* is right) and it says nothing about whether the day reads as
 * the right *sequence of trips*. This scorer works at the granularity a
 * human narrates a day: **journeys** (a run of movement bounded by stays),
 * each a sequence of **legs** (mode + transit line).
 *
 * It answers two questions the per-minute scorer can't:
 *
 *   1. **Leg fidelity** (boundary-robust) — for each ground-truth movement
 *      leg, did the decoder's *dominant* mode over that leg's window match,
 *      and for transit legs, the line? Dominant-over-window absorbs the few
 *      minutes of edge slop that sink the per-minute line score, while still
 *      honestly reporting a *genuinely* wrong mode (e.g. a train leg the
 *      decoder mostly calls walking stays a miss — this is not a fudge).
 *   2. **Trip structure** — did the decoder reconstruct each journey as the
 *      same ordered sequence of modes? (Did it merge two train legs into
 *      one, split one ride into two, or invent a leg?) This is the
 *      regression gate: a change that scrambles a trip's shape fails here
 *      even if per-minute mode accuracy is unchanged.
 *
 * Pure function. No DB, no IO, no globals. Consumes the same
 * `GroundTruthRow[]` and `DecoderMinute[]` as `score-day.ts`.
 */

import type { GroundTruthMode, GroundTruthRow } from "./ground-truth.js";
import { canonicalMode, type DecoderMinute, isMovementMode } from "./score-day.js";

/** One leg of a journey: a contiguous stretch of one movement mode. */
export interface Leg {
	startTs: number;
	/** Exclusive. */
	endTs: number;
	/** Canonical mode (sleeping folded to stationary; only movement modes
	 *  appear as legs). */
	mode: string;
	/** Transit line for train/bus legs; null otherwise or when unknown. */
	line: string | null;
	/** Boarding / alighting station for transit legs. On the ground-truth
	 *  side these come from the cell's `From → To` (asserted only on
	 *  definite rows); on the decoder side they are null until the decoder
	 *  emits journey structure (C4.3) — the scoreboard counts that as
	 *  `missing`, distinct from wrong. */
	board: string | null;
	alight: string | null;
}

/** A journey: a maximal run of consecutive movement legs (bounded by a
 *  stay / sleep / gap on each side). */
export interface Journey {
	startTs: number;
	endTs: number;
	legs: Leg[];
}

export interface JourneyScore {
	/** Number of journeys the ground truth describes. */
	journeysExpected: number;
	/** Of `journeysExpected`, how many the decoder reconstructed with the
	 *  same ordered (deduped) sequence of leg modes. */
	journeysModeSequenceMatched: number;
	/** Ground-truth movement legs (from `correct` rows) — the scorable
	 *  denominator for leg mode fidelity. */
	legModeScorable: number;
	/** Of `legModeScorable`, how many had the decoder's dominant mode
	 *  (over the leg window) match. */
	legModeMatching: number;
	/** Ground-truth transit legs that name a line — denominator for line
	 *  fidelity. */
	legLineScorable: number;
	/** Of `legLineScorable`, how many had the decoder's dominant line
	 *  (over the mode-matching minutes) match. */
	legLineMatching: number;
	/** Per-leg outcomes, for human inspection. */
	legResults: LegResult[];
	/** Per-GT-journey reconstruction outcome, keyed by the (narrative-stable)
	 *  journey start time — the identity the ratchet gate tracks so a specific
	 *  previously-reconstructed journey breaking is a failure, not just a count
	 *  dropping. */
	journeyResults: JourneyResult[];
}

export interface JourneyResult {
	/** GT journey start (unix seconds) — stable across pipeline changes because
	 *  it is anchored to the fixed narrative window. */
	startTs: number;
	endTs: number;
	/** The trip's expected deduped mode shape (e.g. ["walking","train","walking"]). */
	expectedShape: string[];
	/** The reconstructed shape of the best-overlapping output journey, or null
	 *  when nothing overlapped. */
	actualShape: string[] | null;
	/** True when `actualShape` equals `expectedShape`. */
	matched: boolean;
}

/** Expand a coarse state timeline (contiguous start/end/mode windows — the
 *  drawn "Your Day" timeline) into the per-minute stream {@link scoreJourneys}
 *  consumes, so the PIPELINE output can be journey-scored, not only the HSMM
 *  decoder. Emits one entry per top-of-minute inside each window; line/place
 *  are not carried (mode-shape scoring needs only mode — line fidelity uses the
 *  decoder path). */
export function statesToMinutes(states: readonly { startTs: number; endTs: number; mode: string }[]): DecoderMinute[] {
	const minutes: DecoderMinute[] = [];
	for (const s of states) {
		for (let t = Math.ceil(s.startTs / 60) * 60; t < s.endTs; t += 60) {
			minutes.push({ ts: t, mode: s.mode as DecoderMinute["mode"], placeId: null, lineName: null });
		}
	}
	return minutes;
}

export interface LegResult {
	startTs: number;
	endTs: number;
	expectedMode: string;
	dominantDecoderMode: string | null;
	modeMatch: boolean;
	expectedLine: string | null;
	dominantDecoderLine: string | null;
	/** `na` when the leg isn't a transit leg with a named line. */
	lineMatch: "match" | "mismatch" | "na";
}

/** A stay shorter than this is an *in-journey pause* (a platform wait, an
 *  interchange, a GPS-null blip) and does NOT end the journey; a stay this
 *  long or longer is a destination that ends it. Without this, a single
 *  stationary minute mid-trip shatters one journey into several — the metric
 *  would then punish "trip structure" for noise, not for a real fragmentation.
 *  Applied symmetrically to the ground-truth and decoder sides so they are
 *  comparable. 5 min absorbs waits/blips without merging genuine visits. */
const JOURNEY_PAUSE_MAX_S = 5 * 60;

/** Build the ground-truth leg + journey structure from the audit rows.
 *  The cell is always the TRUTH (see `ground-truth.ts`), so `correct` and
 *  `wrong` rows contribute legs alike — a `wrong` row is a true leg the
 *  pipeline is KNOWN to miss, which is exactly what this metric must keep
 *  demanding (excluding it would silently drop the broken legs the score
 *  exists to measure). Consecutive movement rows form one journey; a
 *  non-movement stay of `JOURNEY_PAUSE_MAX_S`+ (or an `unclear`/unparsed
 *  row) breaks the run, while a shorter stay is absorbed as an in-journey
 *  pause. */
export function groundTruthJourneys(rows: readonly GroundTruthRow[]): Journey[] {
	const journeys: Journey[] = [];
	let current: Leg[] = [];
	// A journey must be anchored by ≥1 definite (`correct`/`wrong`) leg to be
	// demanded. A `partial` row EXTENDS a journey (a partial train mid-trip
	// keeps it one journey — only a detail like line/exact station is
	// imperfect, the MODE is right) but does not SEED one: a run of
	// only-partial movement is too uncertain to assert.
	let currentHasDefinite = false;
	const flush = (): void => {
		if (current.length > 0 && currentHasDefinite) {
			journeys.push({ startTs: current[0].startTs, endTs: current[current.length - 1].endTs, legs: current });
		}
		current = [];
		currentHasDefinite = false;
	};
	for (const row of rows) {
		const b = row.truth;
		// The audit tables are SPARSE — they need not list every stay. A time
		// gap between rows longer than a pause is unaudited time we cannot
		// assert continuity across (without this, two trips hours apart with
		// no stay row between them concatenate into one impossible demand).
		const prevEnd = current[current.length - 1]?.endTs;
		if (prevEnd !== undefined && row.startTs - prevEnd > JOURNEY_PAUSE_MAX_S) flush();
		// Usable for journey SHAPE when the cell's mode is a definite truth
		// claim: `correct`, `wrong`, and `partial` all name the true mode;
		// `unclear` / unparsed rows can't assert continuity, so they break
		// the journey.
		if (row.status === "unclear" || b === null) {
			flush();
			continue;
		}
		if (!isMovementMode(b.mode)) {
			// A long stay ends the journey; a brief pause is absorbed.
			if (row.endTs - row.startTs >= JOURNEY_PAUSE_MAX_S) flush();
			continue;
		}
		// Stations are only ASSERTED by definite rows — a `partial` cell's
		// From → To is approximate by declaration and must not convict a
		// mismatch.
		const definite = row.status === "correct" || row.status === "wrong";
		const fromTo = definite ? b.trainFromTo : null;
		current.push({
			startTs: row.startTs,
			endTs: row.endTs,
			mode: canonicalMode(b.mode),
			line: lineOf(b.mode, b.lineName),
			board: fromTo?.from ?? null,
			alight: fromTo?.to ?? null,
		});
		if (definite) currentHasDefinite = true;
	}
	flush();
	return journeys;
}

/** Build movement journeys directly from a coarse state timeline (the drawn
 *  "Your Day" windows), WITHOUT quantising to minutes. This is the pipeline
 *  analogue of {@link groundTruthJourneys}: it preserves a sub-minute leg (a
 *  brief station-change train `10:34–10:34`) that `statesToMinutes` silently
 *  drops — the bug that scored a correct 06-22 reconstruction as broken.
 *  Consecutive same-mode movement windows merge; a stay / gap of
 *  `pauseMaxS`+ ends the journey. */
export function statesToJourneys(
	states: readonly { startTs: number; endTs: number; mode: string }[],
	pauseMaxS = JOURNEY_PAUSE_MAX_S,
): Journey[] {
	const legs: Leg[] = [];
	for (const s of states) {
		const sMode = s.mode as DecoderMinute["mode"];
		if (!isMovementMode(sMode)) continue;
		const mode = canonicalMode(sMode);
		const last = legs[legs.length - 1];
		if (last !== undefined && last.mode === mode && s.startTs <= last.endTs + 1) last.endTs = s.endTs;
		else legs.push({ startTs: s.startTs, endTs: s.endTs, mode, line: null, board: null, alight: null });
	}
	const journeys: Journey[] = [];
	let current: Leg[] = [];
	for (const leg of legs) {
		const last = current[current.length - 1];
		if (last !== undefined && leg.startTs - last.endTs > pauseMaxS) {
			journeys.push({ startTs: current[0].startTs, endTs: last.endTs, legs: current });
			current = [];
		}
		current.push(leg);
	}
	if (current.length > 0)
		journeys.push({ startTs: current[0].startTs, endTs: current[current.length - 1].endTs, legs: current });
	return journeys;
}

/** Per-GT-journey reconstruction outcome comparing ground-truth journeys to the
 *  pipeline's (mode-shape equality on the best temporally-overlapping journey).
 *  The gate's referee — decoupled from the lossy minute path {@link scoreJourneys}
 *  uses for the decoder's leg-fidelity scores. */
/** A match must also COVER the ground-truth journey in time, not just echo
 *  its deduped mode shape: when a journey fragments (e.g. a dark-tube ride
 *  rendered as walk+stay+walk+short-train), the first fragment can have the
 *  identical shape — [walking, train, walking] — while spanning a third of
 *  the trip. Uncovered ground-truth time beyond 20% of the journey (with a
 *  4-minute absolute allowance for boundary noise on short hops) fails the
 *  match. */
const COVERAGE_SLACK_FRAC = 0.2;
const COVERAGE_SLACK_MIN_S = 240;

export function journeyShapeResults(
	gtJourneys: readonly Journey[],
	pipelineJourneys: readonly Journey[],
): JourneyResult[] {
	return gtJourneys.map((gt) => {
		const match = bestOverlap(gt, pipelineJourneys);
		const expectedShape = modeShape(gt);
		// Compare structure over the AUDITED span only: the ground truth
		// asserts nothing about time outside its rows, so pipeline legs
		// entirely beyond the journey window must not fail the match. A leg
		// that crosses the boundary still overlaps and is kept.
		const clipped = match === null ? null : match.legs.filter((l) => l.endTs > gt.startTs && l.startTs < gt.endTs);
		const actualShape =
			match !== null && clipped !== null && clipped.length > 0 ? modeShape({ ...match, legs: clipped }) : null;
		const overlap =
			match === null ? 0 : Math.max(0, Math.min(gt.endTs, match.endTs) - Math.max(gt.startTs, match.startTs));
		const uncovered = gt.endTs - gt.startTs - overlap;
		const covered = uncovered <= Math.max(COVERAGE_SLACK_FRAC * (gt.endTs - gt.startTs), COVERAGE_SLACK_MIN_S);
		return {
			startTs: gt.startTs,
			endTs: gt.endTs,
			expectedShape,
			actualShape,
			matched: actualShape !== null && arraysEqual(expectedShape, actualShape) && covered,
		};
	});
}

/** A line only attaches to transit legs. */
function lineOf(mode: GroundTruthMode, lineName: string | null): string | null {
	const c = canonicalMode(mode);
	return c === "train" || c === "bus" ? lineName : null;
}

/** Collapse a per-minute decoder stream into movement legs + journeys.
 *  Consecutive minutes with the same `(canonical mode, line)` merge into a
 *  leg; movement legs separated only by ≤ `gapToleranceMin` of
 *  non-movement still belong to one journey (a brief stay mid-trip — e.g.
 *  a platform wait — does not split the journey). */
export function decoderJourneys(
	minutes: readonly DecoderMinute[],
	gapToleranceMin = JOURNEY_PAUSE_MAX_S / 60,
): Journey[] {
	const sorted = [...minutes].sort((a, b) => a.ts - b.ts);
	// First collapse into legs (movement only).
	const legs: Leg[] = [];
	for (const m of sorted) {
		if (!isMovementMode(m.mode)) continue;
		const mode = canonicalMode(m.mode);
		const line = mode === "train" || mode === "bus" ? m.lineName : null;
		const last = legs[legs.length - 1];
		if (last !== undefined && last.mode === mode && last.line === line && m.ts <= last.endTs) {
			last.endTs = m.ts + 60;
		} else {
			legs.push({ startTs: m.ts, endTs: m.ts + 60, mode, line, board: null, alight: null });
		}
	}
	// Group legs into journeys: a gap larger than the tolerance starts a
	// new journey.
	const journeys: Journey[] = [];
	let current: Leg[] = [];
	for (const leg of legs) {
		const last = current[current.length - 1];
		if (last !== undefined && leg.startTs - last.endTs > gapToleranceMin * 60) {
			journeys.push({ startTs: current[0].startTs, endTs: last.endTs, legs: current });
			current = [];
		}
		current.push(leg);
	}
	if (current.length > 0)
		journeys.push({ startTs: current[0].startTs, endTs: current[current.length - 1].endTs, legs: current });
	return journeys;
}

/** Tally the decoder's canonical mode over [startTs, endTs), and (for the
 *  minutes that match `expectedMode`) the dominant line. Returns the
 *  dominant mode + the dominant line among matching minutes. */
function dominantOverWindow(
	byTs: ReadonlyMap<number, DecoderMinute>,
	startTs: number,
	endTs: number,
	expectedMode: string,
): { mode: string | null; line: string | null } {
	const modeTally = new Map<string, number>();
	const lineTally = new Map<string, number>();
	for (let t = startTs; t < endTs; t += 60) {
		const dm = byTs.get(t);
		if (dm === undefined) continue;
		const c = canonicalMode(dm.mode);
		modeTally.set(c, (modeTally.get(c) ?? 0) + 1);
		if (c === expectedMode && dm.lineName !== null) {
			lineTally.set(dm.lineName, (lineTally.get(dm.lineName) ?? 0) + 1);
		}
	}
	return { mode: argmax(modeTally), line: argmax(lineTally) };
}

/** Key with the highest count, or null when empty. Ties broken by first
 *  insertion (Map iteration order) for determinism. */
function argmax(tally: ReadonlyMap<string, number>): string | null {
	let best: string | null = null;
	let bestN = 0;
	for (const [k, n] of tally) {
		if (n > bestN) {
			bestN = n;
			best = k;
		}
	}
	return best;
}

/** Deduped ordered mode sequence of a journey — the trip's "shape", with
 *  **same-vehicle interchanges smoothed**. A walking leg sandwiched between
 *  two legs of the same vehicle mode (train↔train, bus↔bus) is an
 *  interchange (changing tube lines, changing buses) and is dropped, so a
 *  Met→change→Jubilee ride reads as one `train` — matching how the user
 *  describes the trip (decision 2026-06-13). A walk between *different*
 *  vehicles (tube→bus) is a real transfer and kept; leading/trailing
 *  approach/egress walks are kept. Applied symmetrically to GT and decoder.
 */
function modeShape(journey: Journey): string[] {
	const legs = journey.legs;
	const kept: string[] = [];
	for (let i = 0; i < legs.length; i++) {
		const m = legs[i].mode;
		if (m === "walking" && i > 0 && i < legs.length - 1) {
			const prev = legs[i - 1].mode;
			const next = legs[i + 1].mode;
			const sameVehicle = prev === next && (prev === "train" || prev === "bus");
			if (sameVehicle) continue; // interchange walk — smooth it away
		}
		kept.push(m);
	}
	// Dedupe consecutive identical modes (incl. the two vehicle legs the
	// dropped interchange now leaves adjacent).
	const shape: string[] = [];
	for (const m of kept) {
		if (shape[shape.length - 1] !== m) shape.push(m);
	}
	return shape;
}

/** The decoder journey with the most temporal overlap with `gt`, or null. */
function bestOverlap(gt: Journey, decoderJ: readonly Journey[]): Journey | null {
	let best: Journey | null = null;
	let bestOv = 0;
	for (const d of decoderJ) {
		const ov = Math.max(0, Math.min(gt.endTs, d.endTs) - Math.max(gt.startTs, d.startTs));
		if (ov > bestOv) {
			bestOv = ov;
			best = d;
		}
	}
	return best;
}

export function scoreJourneys(rows: readonly GroundTruthRow[], decoder: readonly DecoderMinute[]): JourneyScore {
	const byTs = new Map<number, DecoderMinute>();
	for (const m of decoder) byTs.set(m.ts, m);

	const gtJourneys = groundTruthJourneys(rows);
	const decJourneys = decoderJourneys(decoder);

	let legModeScorable = 0;
	let legModeMatching = 0;
	let legLineScorable = 0;
	let legLineMatching = 0;
	let journeysModeSequenceMatched = 0;
	const legResults: LegResult[] = [];
	const journeyResults: JourneyResult[] = [];

	for (const gtJ of gtJourneys) {
		for (const leg of gtJ.legs) {
			legModeScorable++;
			const dom = dominantOverWindow(byTs, leg.startTs, leg.endTs, leg.mode);
			const modeMatch = dom.mode === leg.mode;
			if (modeMatch) legModeMatching++;

			// Line is only scorable on a mode-matched leg — a leg the decoder
			// didn't even call transit can't have a creditable line (mirrors
			// `score-day.ts`: line counts only where both agree on the mode).
			let lineMatch: LegResult["lineMatch"] = "na";
			if (leg.line !== null && modeMatch) {
				legLineScorable++;
				lineMatch = dom.line === leg.line ? "match" : "mismatch";
				if (lineMatch === "match") legLineMatching++;
			}

			legResults.push({
				startTs: leg.startTs,
				endTs: leg.endTs,
				expectedMode: leg.mode,
				dominantDecoderMode: dom.mode,
				modeMatch,
				expectedLine: leg.line,
				dominantDecoderLine: dom.line,
				lineMatch,
			});
		}

		const match = bestOverlap(gtJ, decJourneys);
		const expectedShape = modeShape(gtJ);
		const actualShape = match !== null ? modeShape(match) : null;
		const matched = actualShape !== null && arraysEqual(expectedShape, actualShape);
		if (matched) journeysModeSequenceMatched++;
		journeyResults.push({ startTs: gtJ.startTs, endTs: gtJ.endTs, expectedShape, actualShape, matched });
	}

	return {
		journeysExpected: gtJourneys.length,
		journeysModeSequenceMatched,
		legModeScorable,
		legModeMatching,
		legLineScorable,
		legLineMatching,
		legResults,
		journeyResults,
	};
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
