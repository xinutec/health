/**
 * The one-way CEILING — the count-shaped sibling of `floor-gate.ts`.
 *
 * Where a floor records the things the pipeline gets RIGHT and may only grow, a
 * ceiling records standing DEFECTS as a per-day count and may only shrink: the
 * physically-impossible kinematic legs of `worldline-feasibility.ts`, and the
 * labelled train legs naming a station their line does not serve (#181/#351). A
 * day emitting more than its committed count is a regression; a day emitting
 * fewer is an improvement to re-bless.
 *
 * The counts lived inline in `golden-check.ts` while every set-shaped ratchet
 * beside them (`floor-gate.ts`, `delta-ceiling.ts`) sat in a tested module, and
 * the one rule both of those had learned was the one the counts were missing:
 * a day that did not replay measured NOTHING, and silence is not zero.
 *
 * Pure module. No IO.
 */

/** Per-date count of standing defects. */
export type CeilingBaseline = Record<string, number>;

export interface CeilingGateResult {
	/** Days above their committed ceiling — the failures. */
	regressed: { date: string; was: number; now: number }[];
	/** Days below their ceiling — re-bless to ratchet it down. */
	improvedDays: number;
	/** Days the run could not measure, named rather than scored. */
	unmeasured: string[];
}

/**
 * Compare a run against the committed ceiling, over the days actually measured.
 *
 * The `measured` split is the whole point. `current[date] ?? 0` cannot tell a
 * day with no defects from a day that never ran, and against a non-zero ceiling
 * the second reads as the first: the day drops out of the failures and into
 * `improvedDays`, and the run invites a re-bless on the strength of it. So a
 * change that breaks a fixture AND worsens that day reports as an improvement —
 * the one direction a ratchet must never get wrong.
 */
export function gateCeiling(
	committed: CeilingBaseline,
	current: CeilingBaseline,
	measured: ReadonlySet<string>,
	attempted: ReadonlySet<string> = new Set(),
): CeilingGateResult {
	const regressed: { date: string; was: number; now: number }[] = [];
	const unmeasured: string[] = [];
	let improvedDays = 0;
	// `attempted` is every day the run set out to cover. Without it the sweep is
	// the union of the two baselines, and a day at ceiling ZERO appears in
	// neither — so a day carrying no standing debt that quietly stops replaying
	// is not named anywhere. That is the case where a NEW defect hides best: it
	// cannot regress a ceiling it is no longer measured against.
	for (const date of [...new Set([...Object.keys(committed), ...Object.keys(current), ...attempted])].sort()) {
		if (!measured.has(date)) {
			unmeasured.push(date);
			continue;
		}
		const was = committed[date] ?? 0;
		const now = current[date] ?? 0;
		if (now > was) regressed.push({ date, was, now });
		else if (now < was) improvedDays++;
	}
	return { regressed, improvedDays, unmeasured };
}

/**
 * Merge a fresh run into the committed ceiling, keeping the ratchet one-way:
 * `min(committed, current)` per day.
 *
 * The gate's whole claim is that these ceilings "can only shrink", but until
 * 2026-07-27 the `--bless-*` flags wrote the current counts WHOLESALE — so a
 * bless run that fixed four days and left one red silently raised that day's
 * ceiling and the standing failure disappeared from the gate. A run may fix
 * some days without fixing all of them; blessing the wins must not also bless
 * the losses. A day above its ceiling keeps the lower committed value and goes
 * on failing until it is genuinely fixed.
 *
 * A day absent from `measured` counted nothing, so it keeps what it had: the
 * `?? 0` that reads silence as zero would otherwise record a fix nobody
 * observed and drop that day to the strictest ceiling there is, on no evidence.
 */
export function ratchetDownCounts(
	committed: CeilingBaseline | null,
	current: CeilingBaseline,
	measured: ReadonlySet<string>,
): CeilingBaseline {
	const ordered: CeilingBaseline = {};
	for (const date of [...new Set([...Object.keys(committed ?? {}), ...Object.keys(current)])].sort()) {
		if (committed !== null && !measured.has(date)) {
			const held = committed[date] ?? 0;
			if (held > 0) ordered[date] = held;
			continue;
		}
		// A day MISSING from the committed baseline has a ceiling of ZERO — that
		// is how the gate reads it everywhere else (`baseline[date] ?? 0`), so a
		// newly-offending day cannot be blessed in by omission either.
		// `committed === null` is the distinct bootstrap case (no baseline file at
		// all): nothing to ratchet against, so the current counts establish the
		// first ceiling.
		const floor = committed === null ? (current[date] ?? 0) : Math.min(committed[date] ?? 0, current[date] ?? 0);
		if (floor > 0) ordered[date] = floor;
	}
	return ordered;
}
