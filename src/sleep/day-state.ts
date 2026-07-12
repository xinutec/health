/**
 * DayState — bottom layer of the three-altitude data model.
 *
 * Each `DayState` is a non-overlapping interval describing one thing
 * the person was doing. Mode is mutually exclusive at any moment;
 * `sleeping` is one mode. Attributes qualify the state (e.g.
 * `asleep` on a moving state means sleeping-while-in-transit).
 * Spans bigger than one state (city, journey, day-part) live in a
 * separate "overlay" layer outside this module.
 *
 * Sleep is rendered for the FULL Fitbit window — not clipped to
 * the segments that happen to overlap. Concretely: morning sleep
 * that began at 23:43 yesterday with first GPS fix at 07:47 today
 * is shown as a single sleeping state from 23:43 yesterday to the
 * wake-up timestamp. The "your day" narrative tells me when I fell
 * asleep, not just the slice between fixes.
 *
 * Algorithm: boundary sweep. Collect every distinct boundary
 * timestamp from segments and sleep windows, then for each
 * sub-interval pick the state from the (at most one) overlapping
 * segment and the (at most one) overlapping sleep window. Synthetic
 * sleeping states fill sleep-window gaps that no segment covers.
 *
 * The converter is pure: no DB access, no side effects.
 */

import type { TransportMode } from "../geo/segments.js";
import type { EnrichedSegment } from "../geo/velocity.js";

/** What the timeline can show for a stretch of the day: every {@link TransportMode}
 *  the classifier can attribute, plus the two the segment layer cannot express —
 *  `sleeping` (which comes from the Fitbit sleep windows, not from GPS) and `bus`
 *  (which lives on a segment as `vehicleKind`, not as a mode; see the flattening
 *  in {@link segmentsToStates}).
 *
 *  Derived from `TransportMode` rather than hand-listed, so adding a mode to the
 *  classifier cannot silently fail to reach the UI. */
export type DayStateMode = TransportMode | "sleeping" | "bus";

export interface SleepWindow {
	startTs: number;
	endTs: number;
	/** Place name (e.g. "Home", "Hotel X"). Used to decide whether
	 *  to rewrite an overlapping stationary segment to sleeping
	 *  mode AND to label the synthesized sleeping state when no
	 *  segment covers the gap. Null means the sleep occurred while
	 *  moving (overnight train, plane) — no place to match, no
	 *  synthesis. */
	place: string | null;
	minutesAsleep: number;
	tz: string | null;
}

export interface DayState {
	startTs: number;
	endTs: number;
	mode: DayStateMode;
	/** Human-readable place label (for stationary / sleeping). */
	place?: string;
	/** Human-readable way label (for moving — road, line, station-pair). */
	wayName?: string;
	/** True when the user was asleep but the underlying state is
	 *  not "sleeping" (i.e. sleeping while in transit). When mode
	 *  itself is "sleeping" this attribute is omitted — would be
	 *  redundant. */
	asleep?: boolean;
	/** IANA tz the state's timestamps should render in. Sourced
	 *  from the underlying segment's displayTz, or from the sleep
	 *  window's tz for synthesized sleeping intervals. */
	tz?: string;
	/** For sleeping states only: minutes the user was actually asleep
	 *  (Fitbit's minutes_asleep). Differs from the wall-clock span
	 *  endTs-startTs by the time spent awake in bed. The UI renders
	 *  "8h 45m in bed (7h 18m asleep)" when set. */
	minutesAsleep?: number;
	/** True when this state is inferred rather than observed — there was
	 *  no GPS/biometric data for the interval, but the day is fully
	 *  constrained by the surrounding days (same place before and after),
	 *  so the stay is asserted with an honest "no data" caveat. Confidence
	 *  here comes from constraint, not from data volume. The UI renders it
	 *  muted with an "inferred — no data" qualifier. */
	inferred?: boolean;
}

/** Public entry: convert segments + sleep windows into the day's
 *  non-overlapping state sequence. Adjacent same-state runs are
 *  merged. */
export function segmentsToDayStates(
	segments: readonly EnrichedSegment[],
	sleepWindows: readonly SleepWindow[],
): DayState[] {
	const boundaries = collectBoundaries(segments, sleepWindows);
	if (boundaries.length < 2) return [];

	const states: DayState[] = [];
	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i];
		const end = boundaries[i + 1];
		const mid = start + (end - start) / 2;
		const seg = findCovering(segments, mid);
		const sleep = findCoveringSleep(sleepWindows, mid);
		const state = stateForInterval(start, end, seg, sleep);
		if (state) states.push(state);
	}
	return stripPartialMinutesAsleep(mergeAdjacent(states), sleepWindows);
}

/**
 * Never assert the future. Inferred states (dwell-prior continuation,
 * empty-day inference) can extend to a survival horizon or the day end that
 * lies ahead of the current moment; for today that would claim presence at a
 * place hours before it has happened. Clip any inferred state to `nowTs`:
 * truncate one that straddles now, drop one wholly in the future. Observed
 * states are untouched (real data can't be in the future). Presentation-layer
 * only — the pipeline stays deterministic (fills to the horizon) so goldens,
 * which replay past days where `nowTs` is already past the day end, are
 * unaffected.
 */
export function clipInferredFuture(states: readonly DayState[], nowTs: number): DayState[] {
	const out: DayState[] = [];
	for (const s of states) {
		if (!s.inferred || s.endTs <= nowTs) {
			out.push(s);
			continue;
		}
		if (s.startTs >= nowTs) continue; // wholly future — drop
		out.push({ ...s, endTs: nowTs }); // straddles now — truncate
	}
	return out;
}

/** After merging adjacent same-state runs, a sleeping state's
 *  range either matches its sleep window exactly (the asleep
 *  total describes the whole row, OK to show) or covers only
 *  part of it (split across mid-night events: the row is shorter
 *  than the asleep duration). For partial rows, strip
 *  `minutesAsleep` so the UI doesn't claim a multi-hour asleep
 *  total on a row that's only a fraction of the window long. */
function stripPartialMinutesAsleep(states: readonly DayState[], sleepWindows: readonly SleepWindow[]): DayState[] {
	const matchesFullWindow = (s: DayState): boolean =>
		sleepWindows.some((w) => w.startTs === s.startTs && w.endTs === s.endTs);
	return states.map((s) => {
		if (s.mode !== "sleeping" || s.minutesAsleep === undefined) return s;
		if (matchesFullWindow(s)) return s;
		const { minutesAsleep: _omit, ...rest } = s;
		return rest;
	});
}

function collectBoundaries(segments: readonly EnrichedSegment[], sleepWindows: readonly SleepWindow[]): number[] {
	const set = new Set<number>();
	for (const s of segments) {
		set.add(s.startTs);
		set.add(s.endTs);
	}
	for (const w of sleepWindows) {
		set.add(w.startTs);
		set.add(w.endTs);
	}
	return [...set].sort((a, b) => a - b);
}

function findCovering(segments: readonly EnrichedSegment[], ts: number): EnrichedSegment | undefined {
	return segments.find((s) => s.startTs <= ts && ts < s.endTs);
}

function findCoveringSleep(sleepWindows: readonly SleepWindow[], ts: number): SleepWindow | undefined {
	return sleepWindows.find((w) => w.startTs <= ts && ts < w.endTs);
}

function stateForInterval(
	start: number,
	end: number,
	seg: EnrichedSegment | undefined,
	sleep: SleepWindow | undefined,
): DayState | null {
	// No segment, no sleep — nothing to say about this interval.
	// Happens when sleep windows leave gaps between today's morning
	// and evening sleep (the awake hours that have no segments — but
	// those are usually filled, so this is only the very-edge case
	// of "no data at all").
	if (!seg && !sleep) return null;

	// Sleep window covers a stretch with no GPS coverage: emit a
	// synthesized sleeping state at the sleep place. This is what
	// makes the morning-sleep-before-first-fix and evening-sleep-
	// after-last-fix narratives appear in the timeline.
	if (!seg && sleep) {
		if (sleep.place === null) return null; // overnight in transit, no place → can't synthesize
		const out: DayState = { startTs: start, endTs: end, mode: "sleeping", place: sleep.place };
		if (sleep.tz) out.tz = sleep.tz;
		if (sleep.minutesAsleep > 0) out.minutesAsleep = sleep.minutesAsleep;
		return out;
	}

	// From here on, seg is defined (TypeScript narrowing).
	const segment = seg as EnrichedSegment;
	// vehicleKind refines a driving leg into a bus for display (task
	// #247) — the transport-mode machinery upstream still says driving.
	const segMode: DayStateMode = segment.vehicleKind === "bus" ? "bus" : (segment.refinedMode ?? segment.mode);

	if (!sleep) {
		return makeStateFromSegment(segment, start, end, segMode, false);
	}

	// Sleep window overlaps this segment-covered interval.
	if (segMode === "stationary") {
		// Stationary at sleep place → sleeping mode.
		if (sleep.place !== null && segment.place === sleep.place) {
			const out: DayState = { startTs: start, endTs: end, mode: "sleeping", place: segment.place };
			// tz: prefer the sleep window's tz over the segment's
			// displayTz so the rewritten half matches the synthesized
			// half's tz string. When the two strings differ but
			// represent the same wall clock (two IANA names for the
			// same offset), strict equality in `sameState` would
			// otherwise prevent mergeAdjacent from collapsing the
			// two halves of one sleep into a single row.
			if (sleep.tz) out.tz = sleep.tz;
			else if (segment.displayTz) out.tz = segment.displayTz;
			if (sleep.minutesAsleep > 0) out.minutesAsleep = sleep.minutesAsleep;
			return out;
		}
		// Stationary at a different place (user awake at the desk
		// while Fitbit thinks they're asleep): defer to GPS.
		return makeStateFromSegment(segment, start, end, segMode, false);
	}

	// Moving + sleep window → keep mode, add asleep attribute.
	return makeStateFromSegment(segment, start, end, segMode, true);
}

function makeStateFromSegment(
	seg: EnrichedSegment,
	startTs: number,
	endTs: number,
	mode: DayStateMode,
	asleep: boolean,
): DayState {
	const state: DayState = { startTs, endTs, mode };
	if (seg.place !== undefined) state.place = seg.place;
	if (seg.wayName !== undefined) state.wayName = seg.wayName;
	if (asleep && mode !== "sleeping") state.asleep = true;
	if (seg.displayTz) state.tz = seg.displayTz;
	return state;
}

function mergeAdjacent(states: readonly DayState[]): DayState[] {
	const out: DayState[] = [];
	for (const s of states) {
		const prev = out[out.length - 1];
		if (prev && prev.endTs === s.startTs && sameState(prev, s)) {
			prev.endTs = s.endTs;
		} else {
			out.push({ ...s });
		}
	}
	return out;
}

function sameState(a: DayState, b: DayState): boolean {
	return (
		a.mode === b.mode &&
		a.place === b.place &&
		a.wayName === b.wayName &&
		a.asleep === b.asleep &&
		a.tz === b.tz &&
		a.minutesAsleep === b.minutesAsleep
	);
}
