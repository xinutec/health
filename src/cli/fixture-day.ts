/**
 * Fixture format for the deterministic v2 golden harness.
 *
 * Phase 6f of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * A `CapturedDay` is the closure of one day's classification inputs plus
 * the expected output. `capture-day-v2` builds it by loading
 * `ClassificationInputs` with a `RecordingOsmAdapter` (so every OSM /
 * Nominatim lookup the pipeline makes is recorded), running the pure core
 * once, and serialising both. `golden-check-v2` reads it back, rebuilds
 * the inputs with a `FixtureOsmAdapter` over the captured trace, and runs
 * the same core — no DB, no network. Re-running any commit's check on the
 * same fixture produces the same result; the OSM mirror / decoded_days
 * drift that made the v1 corpus non-deterministic cannot reach it.
 */

import { z } from "zod";
import type { ClassificationInputs } from "../geo/classification-inputs.js";
import { FixtureOsmAdapter } from "../geo/osm-adapter-fixture.js";
import type { OsmTrace } from "../geo/osm-adapter-recording.js";
import { RowSetOsmAdapter } from "../geo/osm-adapter-rowset.js";
import type { OsmRowSet } from "../geo/osm-rowset.js";
import type { FoldCaptureFile } from "../lean/fold-capture.js";
import type { NormalizedState } from "./state-diff.js";

/** Bumped only when a schema change alters classifier output. See the
 *  proposal's "Schema evolution" open question — we lean permissive
 *  (load old fixtures, missing fields default) and bump the version
 *  only when a missing field would change the result. */
export const FIXTURE_FORMAT_VERSION = 1;

/** `ClassificationInputs` as stored on disk: every field except the
 *  non-serialisable `osm` adapter, which is replaced by the captured
 *  `osmTrace` that replay rebuilds a `FixtureOsmAdapter` from.
 *
 *  `osmRowSet` is the raw OSM rows within the day's buffered track
 *  (`docs/proposals/2026-07-osm-into-lean.md`). When present, replay answers
 *  the five kernel lookups by COMPUTING over those rows instead of replaying
 *  `osmTrace`'s captured answers — which is the entire point of the row-set
 *  work: a captured answer keeps the spatial predicate an oracle, and an
 *  oracle cannot be stated as a definition or carry a theorem.
 *
 *  Both are stored, deliberately. The trace remains the record of what MariaDB
 *  said, so a fixture is self-contained evidence for the comparison rather than
 *  needing a live mirror to re-derive it. */
export type SerializedInputs = Omit<ClassificationInputs, "osm"> & {
	osmTrace: OsmTrace;
	osmRowSet?: OsmRowSet;
};

export interface CapturedDay {
	meta: {
		fixtureFormatVersion: number;
		/** ISO instant the fixture was captured. */
		capturedAt: string;
		/** git rev the capture ran against — informational drift context. */
		capturedAtCodeSha: string;
		date: string;
		user: string;
		tz: string;
		/** Why the day is in the corpus. Never a personal narrative. */
		description: string;
	};
	inputs: SerializedInputs;
	expected: {
		/** What `golden-check-v2` diffs: the normalised day-state timeline. */
		velocity: NormalizedState[];
		/**
		 * The TS cascade's own run, frozen as data (#975).
		 *
		 * The day gate's oracle used to be produced by RUNNING the TS arm under
		 * `FOLD_CAPTURE` at gate time. That arm is being deleted, and an oracle
		 * that has to be executed dies with the code that computes it — so it is
		 * recorded here, once, while the arm still exists.
		 *
		 * ⚠ BOTH halves are the oracle, and neither can be recomputed later.
		 *
		 * `capture` holds what the TS run was handed (`segsSplit`/`segsIn`, the tz
		 * and place answers) AND what it produced (`segsPre`/`segsOut`/`statesOut`/
		 * `episodesOut`). See `lean/fold-capture.ts` on why it records rather than
		 * re-derives: a recomputed input would ask the LEAN question and answer it,
		 * hiding a disagreement about which coordinate to ask about.
		 *
		 * `osmAnswers` is the trace the TS run's own lookups produced — NOT the
		 * fixture's `inputs.osmTrace`, which is a superset. Substituting the
		 * superset would answer a lookup the TS arm never made, so a leg the Lean
		 * arm re-enriches and the TS arm did not would quietly get an answer
		 * instead of surfacing as a miss. The miss is the finding.
		 *
		 * ⚠ Optional ONLY during the migration. Once the TS arm is gone a fixture
		 * without this cannot be gated at all — there is no second arm to fall back
		 * to — so `compare-day` must REPORT that rather than skip the day.
		 */
		tsArm?: {
			capture: FoldCaptureFile;
			osmAnswers: OsmTrace;
		};
	};
}

/** Envelope validation: strict on `meta` + the version gate, permissive
 *  on the inner closure. The inputs/expected payloads are produced by
 *  TS-typed code and consumed only locally; re-deriving zod schemas for
 *  every nested OSM result type would be brittle duplication with no
 *  safety gain over the producer's compile-time types. */
const capturedDaySchema = z.object({
	meta: z.object({
		fixtureFormatVersion: z.number(),
		capturedAt: z.string(),
		capturedAtCodeSha: z.string(),
		date: z.string(),
		user: z.string(),
		tz: z.string(),
		description: z.string().default(""),
	}),
	inputs: z.unknown(),
	// ⚠ `tsArm` must be DECLARED, not merely permitted: zod strips unknown
	// keys, so an undeclared field would be silently dropped on every parse — the
	// fixture would keep it on disk and the gate would never see it.
	expected: z.object({ velocity: z.array(z.unknown()), tsArm: z.unknown().optional() }),
});

/** Parse + version-gate a fixture file's JSON. Throws on a format
 *  version mismatch with an actionable re-capture message. */
export function parseCapturedDay(json: string): CapturedDay {
	const raw = capturedDaySchema.parse(JSON.parse(json));
	if (raw.meta.fixtureFormatVersion !== FIXTURE_FORMAT_VERSION) {
		throw new Error(
			`fixture format version ${raw.meta.fixtureFormatVersion} != ${FIXTURE_FORMAT_VERSION} — re-capture with capture-day-v2`,
		);
	}
	return raw as unknown as CapturedDay;
}

/** Split a loaded `ClassificationInputs` into the serialisable closure,
 *  dropping the live `osm` adapter in favour of the recorded trace and, when
 *  the capture path loaded one, the raw OSM rows. */
export function toSerializedInputs(
	inputs: ClassificationInputs,
	osmTrace: OsmTrace,
	osmRowSet?: OsmRowSet,
): SerializedInputs {
	const { osm: _osm, ...rest } = inputs;
	return osmRowSet ? { ...rest, osmTrace, osmRowSet } : { ...rest, osmTrace };
}

/**
 * Rebuild a runnable `ClassificationInputs` from a stored closure. Pure — no
 * DB, no network.
 *
 * With a captured row-set the five kernel lookups are COMPUTED from the rows
 * and everything else (Nominatim, `stationsOnLine`, the bulk geometry readers)
 * still replays from the trace — `RowSetOsmAdapter` delegates exactly those.
 * Without one, the whole surface replays from the trace as before, so fixtures
 * captured before the row-set landed still load and still mean what they meant.
 *
 * That fallback is a compatibility path, not a safety net: a day replayed
 * without rows is answering from the oracle, and the two are NOT equivalent —
 * see the parity numbers in `docs/proposals/2026-07-osm-into-lean.md`. Which
 * one a fixture used is visible in the file, and `golden-check` reports it.
 */
export function inputsFromFixture(captured: CapturedDay, osmSource: OsmSource = "rows"): ClassificationInputs {
	const { osmTrace, osmRowSet, ...rest } = captured.inputs;
	const fixture = new FixtureOsmAdapter(osmTrace);
	const useRows = osmSource === "rows" && osmRowSet !== undefined;
	return { ...rest, osm: useRows ? new RowSetOsmAdapter(osmRowSet as OsmRowSet, fixture) : fixture };
}

/**
 * Which side of the OSM port to replay on.
 *
 * `"trace"` exists for exactly one job: attributing a corpus diff. A re-capture
 * pulls fresh inputs from prod, so its diff mixes the row-set change with OSM
 * mirror drift and with whatever else moved (decoded days, re-mined focus
 * places). Replaying the SAME fixture both ways holds all of that fixed and
 * varies only the OSM path, so a difference between the two runs is the port
 * and a regression present in both is drift.
 *
 * It is a diagnostic axis, not a supported mode — `"trace"` answers from the
 * captured oracle, which is the thing the port exists to remove.
 */
export type OsmSource = "rows" | "trace";

/** Whether a fixture answers its kernel lookups from raw rows or from the
 *  captured oracle. Reported by the harnesses so a mixed corpus is visible
 *  rather than something a reader has to infer from a diff. */
export function fixtureAnswersFromRows(captured: CapturedDay): boolean {
	return captured.inputs.osmRowSet !== undefined;
}

/** Whether a fixture computes `stationsOnLine` from pushed rail rows (#414) or
 *  still replays the captured answers. Tracked separately from
 *  {@link fixtureAnswersFromRows} because the two arrived in different commits:
 *  a row-set from before #414 answers the five bbox lookups from rows and this
 *  one from the trace, so a single "from rows" tally would over-report. */
export function fixtureAnswersLinesFromRows(captured: CapturedDay): boolean {
	return captured.inputs.osmRowSet?.railLines !== undefined;
}
