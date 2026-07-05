/**
 * Shared primitives for rendering and diffing the non-overlapping
 * day-state sequence the timeline shows.
 *
 * Two CLIs use this module today:
 *
 *   - `golden-check.ts` — diffs the live computeVelocity output
 *     against a blessed baseline file, asserting nothing regressed.
 *   - `backtest-classification.ts` — diffs the legacy
 *     `USE_FACTOR_SCORER=0` output against the flag-on factor-scorer
 *     output across a date range, measuring what flipping the flag
 *     in prod would change.
 *
 * The shapes are intentionally minimal — exactly what the timeline
 * renders — so a diff reads as "would this line on the screen
 * change?" rather than as a noisy dump of internal fields.
 */

import type { DayState } from "../sleep/day-state.js";

/** One state row, reduced to exactly what the timeline renders.
 *  Timestamps are wall-clock HH:MM so the rendering is readable and
 *  stable across the UTC columns the DB stores. */
export interface NormalizedState {
	from: string;
	to: string;
	mode: string;
	/** `@ <place>` for stays, `on <way>` for moving, empty otherwise. */
	label: string;
	asleep: boolean;
}

function hhmm(ts: number, tz: string): string {
	return new Date(ts * 1000).toLocaleTimeString("en-GB", {
		timeZone: tz,
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Project a `DayState[]` (the pipeline's internal shape) into the
 *  renderable `NormalizedState[]` form used by diffs and baselines. */
export function normalizeStates(states: DayState[], tz: string): NormalizedState[] {
	return states.map((s) => ({
		from: hhmm(s.startTs, tz),
		to: hhmm(s.endTs, tz),
		mode: s.mode,
		label: s.place ? `@ ${s.place}` : s.wayName ? `on ${s.wayName}` : "",
		asleep: s.asleep ?? false,
	}));
}

/** Canonical one-line rendering of a state, for diffing and display.
 *  Format matches what `golden-check`'s prior in-file helper produced
 *  so blessed-baseline rendering is unchanged: mode is padded to 11
 *  characters, `(asleep)` slots in between mode and label when set,
 *  trailing whitespace from the mode-pad is preserved (means a label-
 *  less line still occupies the expected column). */
export function stateLine(s: NormalizedState): string {
	const tag = s.asleep ? " (asleep)" : "";
	return `${s.from}-${s.to}  ${s.mode.padEnd(11)}${tag}${s.label ? ` ${s.label}` : ""}`;
}

/** Index-aligned diff of two state lists. Returns whether they are
 *  identical, plus the rendered diff lines suitable for printing.
 *  Caller decides what `-` and `+` mean — golden-check reads them as
 *  "expected" vs "actual"; backtest reads them as "legacy" vs
 *  "factor-scorer". */
export function diffStates(left: NormalizedState[], right: NormalizedState[]): { identical: boolean; lines: string[] } {
	const n = Math.max(left.length, right.length);
	const lines: string[] = [];
	let identical = left.length === right.length;
	for (let i = 0; i < n; i++) {
		const l = left[i];
		const r = right[i];
		const lLine = l ? stateLine(l) : null;
		const rLine = r ? stateLine(r) : null;
		if (lLine === rLine) {
			lines.push(`    ok   ${lLine}`);
			continue;
		}
		identical = false;
		if (lLine !== null) lines.push(`    -    ${lLine}`);
		if (rLine !== null) lines.push(`    +    ${rLine}`);
	}
	return { identical, lines };
}
