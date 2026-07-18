/**
 * HSMM decode persistence: storage shape and (read | write | group)
 * helpers for the `decoded_days` cache table.
 *
 * The HSMM decoder produces per-minute `State[]` (1440 entries per
 * day). That's expensive to store and slow to ship over the wire,
 * so we collapse consecutive same-state minutes into segments at
 * persist time. Consumers (`velocity.ts`, frontend) can then look up
 * the state for a given minute in O(log N segments) via the
 * sorted-by-startTs invariant.
 *
 * `classifier_version` lets future model changes invalidate stale
 * rows: bump `CLASSIFIER_VERSION` when factors / parameters change
 * such that previously-decoded days would now decode differently in
 * a way that matters. A version mismatch on read → treat as missing
 * and re-decode.
 *
 * Pure module for `groupStatesIntoSegments`. DB I/O is isolated to
 * `saveDecode` / `loadDecode` and takes a Kysely instance.
 */

import type { Kysely } from "kysely";
import type { Database } from "../db/tables.js";
import type { ModelledMode } from "../geo/segments.js";
import type { State } from "./state-space.js";

/** Bump when the classifier output for a typical day would change
 *  in a meaningful way. Stale rows in `decoded_days` carry the old
 *  version; consumers re-decode on mismatch.
 *
 *  Version log:
 *  - 1: initial HSMM (entry-prior + visit-frequency + mode-prior)
 *  - 2: added geometric feasibility factor (prev/next-fix
 *       teleport-speed penalty for stat @ knownPlace)
 *  - 3: rail-corridor-boost (station-list) → route-rail-evidence
 *       (route-graph track-geometry, composite-name-aware)
 *  - 4: connectivity check in route-rail-evidence + per-line
 *       GPS-distance factor (line-proximity) at GPS-present
 *       minutes.
 *  - 5: C4.3 chained-triple station resolution — train segments
 *       carry board/alight station names. */
export const CLASSIFIER_VERSION = 5;

/** Per-segment HSMM decode shape. Same conceptual model as the
 *  pipeline's `EnrichedSegment` but trimmed to the fields the HSMM
 *  knows about — no `place` display name, no `wayName`, no
 *  biometric enrichment (those join in at consumer side). */
export interface HmmSegment {
	/** Unix seconds, inclusive. */
	startTs: number;
	/** Unix seconds, exclusive. */
	endTs: number;
	mode: ModelledMode;
	/** focus_places.id for stationary @ knownPlace; null otherwise. */
	placeId: number | null;
	/** Named rail line for train segments; null otherwise. */
	lineName: string | null;
	/** Board/alight station names from the C4.3 chained-triple
	 *  resolver (`station-chain.ts`). Only on named-line train
	 *  segments, and only where the resolver's confidence gate
	 *  passed — a side it could not separate stays null/absent
	 *  (wrong is worse than missing). Absent on pre-v5 rows. */
	boardStation?: string | null;
	alightStation?: string | null;
}

/** Collapse a per-minute state stream into segments. Adjacent
 *  same-(mode, placeId, lineName) minutes merge. Used by the
 *  decoder to produce the compact form before persisting.
 *
 *  `timestamps[i]` is the unix-second value at the start of the
 *  minute containing `states[i]`. The output segment's `endTs` is
 *  the exclusive end — `timestamps[last] + 60`. */
export function groupStatesIntoSegments(states: readonly State[], timestamps: readonly number[]): HmmSegment[] {
	if (states.length !== timestamps.length) {
		throw new Error(
			`groupStatesIntoSegments: states (${states.length}) and timestamps (${timestamps.length}) length mismatch`,
		);
	}
	if (states.length === 0) return [];

	const segments: HmmSegment[] = [];
	let runStart = 0;
	for (let i = 1; i <= states.length; i++) {
		const ended = i === states.length || !sameState(states[i], states[runStart]);
		if (ended) {
			segments.push({
				startTs: timestamps[runStart],
				endTs: timestamps[i - 1] + 60,
				mode: states[runStart].mode,
				placeId: states[runStart].placeId,
				lineName: states[runStart].lineName,
			});
			runStart = i;
		}
	}
	return segments;
}

function sameState(a: State, b: State): boolean {
	return a.mode === b.mode && a.placeId === b.placeId && a.lineName === b.lineName;
}

/** Persist a day's HSMM decode. Overwrites any existing row for
 *  the (user, date) pair — the classifier version is recorded so
 *  consumers can detect stale data on read. */
export async function saveDecode(
	db: Kysely<Database>,
	userId: string,
	date: string,
	segments: readonly HmmSegment[],
): Promise<void> {
	const json = JSON.stringify(segments);
	// MariaDB doesn't have a built-in upsert on multi-column PK that
	// Kysely exposes cleanly. Use raw `ON DUPLICATE KEY UPDATE`.
	await db
		.insertInto("decoded_days")
		.values({
			user_id: userId,
			date,
			classifier_version: CLASSIFIER_VERSION,
			segments_json: json,
		})
		.onDuplicateKeyUpdate({
			classifier_version: CLASSIFIER_VERSION,
			segments_json: json,
		})
		.execute();
}

/** Load a day's HSMM decode if present AND its classifier_version
 *  matches the current value. Returns null on miss or stale row —
 *  consumers should re-decode rather than serve stale segments. */
export async function loadDecode(db: Kysely<Database>, userId: string, date: string): Promise<HmmSegment[] | null> {
	const row = await db
		.selectFrom("decoded_days")
		.where("user_id", "=", userId)
		.where("date", "=", date)
		.select(["classifier_version", "segments_json"])
		.executeTakeFirst();
	if (!row) return null;
	if (row.classifier_version !== CLASSIFIER_VERSION) return null;
	return JSON.parse(row.segments_json) as HmmSegment[];
}
