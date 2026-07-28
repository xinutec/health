/**
 * The one-way FLOOR — the shared mechanism behind every "this used to work
 * and must not stop working" gate in the golden harness.
 *
 * A floor is a committed per-day set of narrative-stable window start times
 * (unix seconds) naming the things the pipeline currently gets right: the
 * ground-truth journeys it reconstructs (`journey-gate.ts`), the confirmed
 * truth rows it still satisfies (the truth ratchet in `golden-check.ts`). A
 * key present in the floor and absent from the current run is a REGRESSION
 * and fails the gate; a key present now and absent from the floor is an
 * IMPROVEMENT to re-bless. The floor can only grow.
 *
 * The keys are window starts because that is the one property a narrative
 * keeps across an edit to its own prose: rewording a row, sharpening a place
 * name, or correcting a line label all leave the window alone. It is not a
 * perfect identity — moving a boundary DOES move the key — which is exactly
 * what {@link ratchetUpFloor}'s `described` argument is for.
 *
 * Pure module. No IO.
 */

/** Per-date set of narrative-stable window start times (unix seconds). */
export type FloorBaseline = Record<string, number[]>;

export interface FloorGateResult {
	/** Floor keys the current run no longer satisfies — the failures. */
	regressed: { date: string; startTs: number }[];
	/** Keys satisfied now but absent from the floor — re-bless to ratchet up.
	 *  Never a failure: new testimony that reveals standing debt is a
	 *  measurement, not a regression. */
	improved: { date: string; startTs: number }[];
}

/**
 * Compare a committed floor against the current run. A regression is a
 * `(date, startTs)` in the floor that is absent from `current`; an
 * improvement is the reverse. `current` maps each date to the keys satisfied
 * this run.
 *
 * Dates absent from `current` are treated as satisfying NOTHING — a caller
 * that cannot measure a day (the fixture threw, the narrative is gone) must
 * exclude it explicitly rather than let this read a silence as a regression.
 */
export function gateFloor(baseline: FloorBaseline, current: FloorBaseline): FloorGateResult {
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

export interface FloorRatchetResult {
	floor: FloorBaseline;
	/** Committed keys the narrative no longer describes, so they left the
	 *  floor. Never silent: dropping a key is how a re-audit escapes the
	 *  gate, and the only thing standing between an honest re-audit and
	 *  "flip the row until the gate goes green" is that it is stated out
	 *  loud at the moment it happens. */
	dropped: { date: string; startTs: number }[];
}

/**
 * Ratchet the floor UP to the current run: the union of the committed keys
 * and the ones satisfied now.
 *
 * A key that used to be satisfied and is not any more STAYS in the floor, so
 * blessing this run's wins cannot quietly drop it — the regression keeps
 * failing until it is actually fixed. The exception is `described`: the keys
 * the day's narrative still contains at all. A key the narrative no longer
 * describes belongs to a row that was rewritten or re-audited away, and a
 * floor holding it would fail forever on something nothing can satisfy. A
 * date ABSENT from `described` was not measured this run (fixture threw, no
 * narrative), and its committed floor passes through untouched rather than
 * being emptied by a silence.
 */
export function ratchetUpFloor(
	committed: FloorBaseline,
	current: FloorBaseline,
	described: FloorBaseline,
): FloorRatchetResult {
	const floor: FloorBaseline = {};
	const dropped: { date: string; startTs: number }[] = [];
	for (const date of [...new Set([...Object.keys(committed), ...Object.keys(current)])].sort()) {
		const day = described[date];
		const committedDay = committed[date] ?? [];
		const kept = day === undefined ? committedDay : committedDay.filter((ts) => day.includes(ts));
		if (day !== undefined) for (const ts of committedDay) if (!day.includes(ts)) dropped.push({ date, startTs: ts });
		floor[date] = [...new Set([...kept, ...(current[date] ?? [])])].sort((a, b) => a - b);
	}
	return { floor, dropped };
}
