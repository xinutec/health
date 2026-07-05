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
 */

/** Per-date set of ground-truth journey start times (unix seconds) the pipeline
 *  reconstructs with the correct mode shape. The committed floor. */
export type JourneyBaseline = Record<string, number[]>;

export interface JourneyGateResult {
	/** Baseline journeys that no longer reconstruct — the regressions that fail
	 *  the gate. */
	regressed: { date: string; startTs: number }[];
	/** Journeys now correct that the baseline didn't have — re-bless to ratchet
	 *  the floor up. Never a failure. */
	improved: { date: string; startTs: number }[];
}

/**
 * Compare the baseline against the current run. A regression is a `(date,
 * startTs)` in the baseline that is absent from `current` — a journey that used
 * to be reconstructed correctly and now is not. An improvement is the reverse.
 * `current` maps each date to the set of GT-journey start times that matched
 * this run.
 */
export function gateJourneys(baseline: JourneyBaseline, current: JourneyBaseline): JourneyGateResult {
	const regressed: { date: string; startTs: number }[] = [];
	const improved: { date: string; startTs: number }[] = [];

	for (const [date, baseTs] of Object.entries(baseline)) {
		const now = new Set(current[date] ?? []);
		for (const ts of baseTs) if (!now.has(ts)) regressed.push({ date, startTs: ts });
	}
	for (const [date, nowTs] of Object.entries(current)) {
		const base = new Set(baseline[date] ?? []);
		for (const ts of nowTs) if (!base.has(ts)) improved.push({ date, startTs: ts });
	}

	const byTs = (a: { date: string; startTs: number }, b: { date: string; startTs: number }): number =>
		a.date === b.date ? a.startTs - b.startTs : a.date < b.date ? -1 : 1;
	regressed.sort(byTs);
	improved.sort(byTs);
	return { regressed, improved };
}
