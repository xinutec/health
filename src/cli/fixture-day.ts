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
import type { NormalizedState } from "./state-diff.js";

/** Bumped only when a schema change alters classifier output. See the
 *  proposal's "Schema evolution" open question — we lean permissive
 *  (load old fixtures, missing fields default) and bump the version
 *  only when a missing field would change the result. */
export const FIXTURE_FORMAT_VERSION = 1;

/** `ClassificationInputs` as stored on disk: every field except the
 *  non-serialisable `osm` adapter, which is replaced by the captured
 *  `osmTrace` that replay rebuilds a `FixtureOsmAdapter` from. */
export type SerializedInputs = Omit<ClassificationInputs, "osm"> & { osmTrace: OsmTrace };

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
	expected: z.object({ velocity: z.array(z.unknown()) }),
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
 *  dropping the live `osm` adapter in favour of the recorded trace. */
export function toSerializedInputs(inputs: ClassificationInputs, osmTrace: OsmTrace): SerializedInputs {
	const { osm: _osm, ...rowSet } = inputs;
	return { ...rowSet, osmTrace };
}

/** Rebuild a runnable `ClassificationInputs` from a stored closure,
 *  wiring a `FixtureOsmAdapter` over the captured trace. Pure — no DB,
 *  no network. */
export function inputsFromFixture(captured: CapturedDay): ClassificationInputs {
	const { osmTrace, ...rowSet } = captured.inputs;
	return { ...rowSet, osm: new FixtureOsmAdapter(osmTrace) };
}
