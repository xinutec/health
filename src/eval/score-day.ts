/**
 * Per-day scorer: compare a decoder's per-minute output against the
 * structured ground-truth rows from `parseGroundTruth`.
 *
 * The output is a triple of (mode-correctness, place-correctness,
 * line-correctness) — each with a `matching` and `scorable` count —
 * plus a per-row breakdown for human inspection. Only rows with
 * status `correct` contribute to scorable counts: those are the
 * minutes where the blessed cell IS the ground truth. Rows with
 * status `wrong` / `partial` / `unclear` are excluded — the human
 * `correctVersionText` is structured-text-free, so we can't reliably
 * score against it yet.
 *
 * Mode equivalence: `sleeping` and `stationary` are treated as the
 * same canonical class. Pipeline emits `sleeping` for night/in-bed
 * minutes; HSMM emits `stationary` with `inBed=true`. The scorer
 * accepts either against a ground-truth `sleeping` cell.
 *
 * Place resolution happens BEFORE this function — the caller passes
 * a `Map<placeName, focus_place_id>` so the scorer can compare ids
 * directly. Unresolved names (no entry in the map) are surfaced in
 * `unresolvedPlaceNames` so the human can either rename the focus
 * place or add an alias.
 *
 * Pure function. No DB, no IO, no globals.
 */

import { type GroundTruthMode, type GroundTruthRow, isEnforceableTruth } from "./ground-truth.js";

export type DecoderMode =
	| "stationary"
	| "sleeping"
	| "walking"
	| "cycling"
	| "driving"
	| "bus"
	| "train"
	| "plane"
	| "unknown";

/** Per-minute decoder output the scorer consumes. */
export interface DecoderMinute {
	/** Unix seconds at the start of this minute. */
	ts: number;
	mode: DecoderMode;
	/** Focus-place id when mode is stationary or sleeping; null
	 *  otherwise or when off-network. */
	placeId: number | null;
	/** Named rail line when mode is train; null otherwise. */
	lineName: string | null;
	/** Board/alight station names for train minutes, from the C4.3
	 *  chained-triple resolver — every minute of a decoded train
	 *  segment carries its segment's pair. Absent/null when the
	 *  resolver stayed silent (missing, not wrong). */
	board?: string | null;
	alight?: string | null;
}

/** A row's per-minute scoring outcome. Surfaced so the human report
 *  can show which rows the decoder got right vs wrong, not just the
 *  aggregate score. */
export interface RowResult {
	row: GroundTruthRow;
	/** Number of minutes in this row's window where decoder mode
	 *  matched the ground-truth mode (after sleeping↔stationary
	 *  equivalence). */
	modeAgreementMinutes: number;
	/** Number of minutes in this row's window covered by decoder
	 *  output (cap: row duration in minutes). */
	rowMinutes: number;
	/** `match` if the row's expected place resolved AND the decoder's
	 *  placeId equals it for every covered minute. `mismatch` if
	 *  resolved but at least one minute differs. `na` if not a
	 *  stationary row OR place didn't resolve. */
	placeAgreement: "match" | "mismatch" | "na";
	/** Same for line, but only fires on train rows. */
	lineAgreement: "match" | "mismatch" | "na";
}

export interface DayScore {
	/** Total minutes covered by the ground-truth audit table. */
	totalMinutes: number;
	/** Subset of `totalMinutes` from rows with status=correct — the
	 *  only minutes where we have a clean reference. */
	scorableMinutes: number;
	/** Of `scorableMinutes`, how many had a matching mode. */
	modeMatching: number;
	/** Subset of `scorableMinutes` where both ground-truth and
	 *  decoder agree the user was stationary AND the ground-truth
	 *  place resolved to an id — the minutes where place attribution
	 *  is comparable. */
	placeScorable: number;
	placeMatching: number;
	/** Subset of `scorableMinutes` where both ground-truth and
	 *  decoder agree on train AND ground-truth names a line — the
	 *  minutes where line attribution is comparable. */
	lineScorable: number;
	lineMatching: number;
	/** Place names from ground-truth rows that the caller's
	 *  resolution map didn't cover. Sorted, de-duplicated. */
	unresolvedPlaceNames: string[];
	rowResults: RowResult[];
}

/** Canonicalise modes so sleeping↔stationary score as a match. */
export function canonicalMode(m: GroundTruthMode | DecoderMode): string {
	if (m === "sleeping") return "stationary";
	return m;
}

/** Modes that count as "moving" — the legs that make up a journey.
 *  `stationary`/`sleeping`/`unknown` are not journey legs; they bound
 *  journeys instead. */
export function isMovementMode(m: GroundTruthMode | DecoderMode): boolean {
	const c = canonicalMode(m);
	return c === "walking" || c === "cycling" || c === "driving" || c === "bus" || c === "train" || c === "plane";
}

export function scoreDay(
	rows: readonly GroundTruthRow[],
	decoder: readonly DecoderMinute[],
	placeNameToId: ReadonlyMap<string, number>,
): DayScore {
	// Index decoder minutes by ts → O(1) lookup per ground-truth minute.
	const decoderByTs = new Map<number, DecoderMinute>();
	for (const m of decoder) decoderByTs.set(m.ts, m);
	// Resolve place names case-insensitively. Callers disagree on key
	// casing — the golden harness lowercases displayName, the unit tests
	// pass title-case — so normalise both the map keys and the lookup to
	// lowercase here. Without this, an exact-case mismatch silently scores
	// every place dimension 0/0 (the golden harness's "Home"/"home" miss).
	const placeByLower = new Map<string, number>();
	for (const [k, v] of placeNameToId) {
		const lk = k.toLowerCase();
		const prior = placeByLower.get(lk);
		// Two distinct display names that case-fold to the same key would
		// otherwise silently resolve to whichever id was inserted last — a
		// place scored as a different place. Surface it rather than hide it.
		if (prior !== undefined && prior !== v) {
			console.warn(`scoreDay: place-name case collision on "${lk}" (ids ${prior} vs ${v}); keeping ${v}`);
		}
		placeByLower.set(lk, v);
	}
	// Round ts to the minute since decoder/ground truth both use 60s
	// granularity. (The caller is responsible for aligning these; this
	// is defensive only.)

	let totalMinutes = 0;
	let scorableMinutes = 0;
	let modeMatching = 0;
	let placeScorable = 0;
	let placeMatching = 0;
	let lineScorable = 0;
	let lineMatching = 0;
	const unresolvedNames = new Set<string>();
	const rowResults: RowResult[] = [];

	for (const row of rows) {
		const rowMinutes = Math.max(0, Math.round((row.endTs - row.startTs) / 60));
		totalMinutes += rowMinutes;

		// Truth-in-cell (#323): the cell states the truth for `correct` AND
		// `wrong` rows alike — `wrong` marks the heuristic PIPELINE's known
		// deviation, not doubt about the truth. The decoder is a different
		// candidate and is scored against both (the wrong rows are exactly the
		// legs it exists to fix), gated on trustworthy provenance like every
		// other truth consumer.
		const scorable = isEnforceableTruth(row) && row.truth !== null;
		if (!scorable) {
			rowResults.push({
				row,
				modeAgreementMinutes: 0,
				rowMinutes,
				placeAgreement: "na",
				lineAgreement: "na",
			});
			continue;
		}
		const blessed = row.truth;
		if (blessed === null) continue; // defensive — scorable already gates on it

		const expectedMode = canonicalMode(blessed.mode);
		const expectedPlaceId = blessed.place === null ? null : (placeByLower.get(blessed.place.toLowerCase()) ?? null);
		if (blessed.place !== null && expectedPlaceId === null) {
			unresolvedNames.add(blessed.place);
		}
		const expectedLine = blessed.lineName;

		let rowModeMatches = 0;
		let rowPlaceMatches = 0;
		let rowPlaceScorable = 0;
		let rowLineMatches = 0;
		let rowLineScorable = 0;

		for (let t = row.startTs; t < row.endTs; t += 60) {
			scorableMinutes++;
			const dm = decoderByTs.get(t);
			if (!dm) continue;
			const dMode = canonicalMode(dm.mode);
			if (dMode === expectedMode) {
				modeMatching++;
				rowModeMatches++;
				// Place comparison only meaningful when both agree on
				// stationary AND ground truth resolved.
				if (expectedMode === "stationary" && expectedPlaceId !== null) {
					placeScorable++;
					rowPlaceScorable++;
					if (dm.placeId === expectedPlaceId) {
						placeMatching++;
						rowPlaceMatches++;
					}
				}
				// Line comparison only on train minutes where ground
				// truth names a line.
				if (expectedMode === "train" && expectedLine !== null) {
					lineScorable++;
					rowLineScorable++;
					if (dm.lineName === expectedLine) {
						lineMatching++;
						rowLineMatches++;
					}
				}
			}
		}

		const placeAgreement: RowResult["placeAgreement"] =
			rowPlaceScorable === 0 ? "na" : rowPlaceMatches === rowPlaceScorable ? "match" : "mismatch";
		const lineAgreement: RowResult["lineAgreement"] =
			rowLineScorable === 0 ? "na" : rowLineMatches === rowLineScorable ? "match" : "mismatch";

		rowResults.push({
			row,
			modeAgreementMinutes: rowModeMatches,
			rowMinutes,
			placeAgreement,
			lineAgreement,
		});
	}

	return {
		totalMinutes,
		scorableMinutes,
		modeMatching,
		placeScorable,
		placeMatching,
		lineScorable,
		lineMatching,
		unresolvedPlaceNames: [...unresolvedNames].sort(),
		rowResults,
	};
}
