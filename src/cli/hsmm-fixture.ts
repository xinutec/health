/**
 * HSMM decode-replay fixture format (#237 Phase 8 / #238 guard).
 *
 * A self-contained capture of one day's `HsmmInputs` plus the decode it
 * produced, so the joint decoder can be replayed with NO database and NO
 * network — the real-data regression test the road-aware line-proximity
 * fix needs (synthetic unit tests have green-lit broken rail geometry
 * before; see the deterministic-fixtures + real-data-fixture notes).
 *
 * The route graph is stored as the raw osm_lines / osm_points rows it was
 * built from; the loader rebuilds it with `buildRouteGraph`, so the graph
 * is deterministic and the fixture stays plain JSON. `bigint` osm ids
 * serialise as strings.
 */

import type { HrPoint, SleepStageRecord, StepPoint } from "../geo/biometrics.js";
import type { FilteredPoint } from "../geo/kalman.js";
import type { RailStopRelation } from "../geo/osm-rail-stops.js";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint } from "../geo/route-graph.js";
import type { HsmmInputs, HsmmPlace } from "../hmm/decode.js";
import type { ContinuityContext } from "../hmm/factors/presence-continuity.js";
import type { HmmSegment } from "../hmm/persist.js";

/** v2 adds `inputs.decodeFlags`. v1 fixtures recorded no configuration at all,
 *  so a replay silently decoded with every C4 flag OFF while production ran
 *  them ON — see `DEFAULT_DECODE_FLAGS`. */
export const HSMM_FIXTURE_FORMAT_VERSION = 2;

/**
 * The four C4 continuity flags. They gate the HSMM decode itself, so a replay
 * that does not set them decodes a DIFFERENT MODEL from the one production
 * runs — and, worse, from the one the fixture's `expected` was blessed under.
 *
 * This is not hypothetical. Before `decodeFlags` existed the corpus had
 * silently split in two: days blessed before the flags went live in production
 * encoded flags-off, `2026-07-12` and `2026-07-14` (blessed 2026-07-17/18)
 * encoded flags-on, and no single run of `golden-hsmm` could be green — it sat
 * at 9/12 with nobody able to say why. The same omission had
 * `score-decoder` reporting eleven regressions across six days that did not
 * exist: with the flags on, the ratchet passes and every metric is BETTER than
 * the blessed baseline. Recording the configuration in the fixture is what
 * makes a red gate mean something. See `feedback_parity_tools_must_mirror_env`.
 */
export interface DecodeFlags {
	imputeCadence: boolean;
	segmentEvidence: boolean;
	chainContext: boolean;
	reacquireRobustSpeed: boolean;
}

/** Production's configuration (kubes `03-auth.yaml` / `08-decode-recent.yaml`:
 *  all four `USE_*` vars set to "1"). What a fixture SHOULD be blessed under,
 *  and what a v1 fixture is assumed to want. */
export const DEFAULT_DECODE_FLAGS: DecodeFlags = {
	imputeCadence: true,
	segmentEvidence: true,
	chainContext: true,
	reacquireRobustSpeed: true,
};

/** The flags a fixture replays under, and whether they were recorded or
 *  assumed. A v1 fixture has none, so the caller is told rather than quietly
 *  handed production defaults — the gate reports it per day. */
export function decodeFlagsFor(captured: HsmmCapturedDay): { flags: DecodeFlags; recorded: boolean } {
	const f = captured.inputs.decodeFlags;
	return f === undefined ? { flags: { ...DEFAULT_DECODE_FLAGS }, recorded: false } : { flags: f, recorded: true };
}

interface SerializedRawOsmLine extends Omit<RawOsmLine, "osm_id"> {
	osm_id: string;
}
interface SerializedRawOsmPoint extends Omit<RawOsmPoint, "osm_id"> {
	osm_id: string;
}

export interface HsmmCapturedDay {
	meta: {
		fixtureFormatVersion: number;
		capturedAt: string;
		capturedAtCodeSha: string;
		date: string;
		user: string;
		tz: string;
		description: string;
	};
	inputs: {
		points: FilteredPoint[];
		hr: HrPoint[];
		steps: StepPoint[];
		sleep: SleepStageRecord[];
		places: HsmmPlace[];
		placeNearLine: string[];
		rawOsmLines: SerializedRawOsmLine[];
		rawOsmPoints: SerializedRawOsmPoint[];
		continuityContext: ContinuityContext | null;
		proximityByMinute: Array<[number, { railDistM: number | null; roadDistM: number | null }]>;
		/** Mirrored rail route relations (#364). Optional: fixtures
		 *  captured before the field replay with no served-station
		 *  evidence — the pre-#364 decode. */
		railStopRelations?: RailStopRelation[];
		/** The C4 flag configuration `expected` was blessed under (v2+).
		 *  Absent in v1 fixtures; see `decodeFlagsFor`. */
		decodeFlags?: DecodeFlags;
	};
	/** The decode this fixture was blessed to expect. */
	expected: HmmSegment[];
}

/** Build the serialisable `inputs` block from live `HsmmInputs` + the raw
 *  OSM rows the route graph was built from. */
export function toSerializedHsmmInputs(
	inputs: HsmmInputs,
	rawOsm: { lines: readonly RawOsmLine[]; points: readonly RawOsmPoint[] },
): HsmmCapturedDay["inputs"] {
	return {
		points: [...inputs.points],
		hr: [...inputs.hr],
		steps: [...inputs.steps],
		sleep: [...inputs.sleep],
		places: [...inputs.places],
		placeNearLine: [...inputs.placeNearLine],
		rawOsmLines: rawOsm.lines.map((l) => ({ ...l, osm_id: l.osm_id.toString() })),
		rawOsmPoints: rawOsm.points.map((p) => ({ ...p, osm_id: p.osm_id.toString() })),
		continuityContext: inputs.continuityContext,
		proximityByMinute: [...(inputs.proximityByMinute ?? new Map())],
		railStopRelations: inputs.railStopRelations === undefined ? undefined : [...inputs.railStopRelations],
		// Record the configuration this day was decoded under, so the replay
		// can never drift from it the way the v1 corpus did.
		decodeFlags: {
			imputeCadence: inputs.imputeCadence === true,
			segmentEvidence: inputs.segmentEvidence === true,
			chainContext: inputs.chainContext === true,
			reacquireRobustSpeed: inputs.reacquireRobustSpeed === true,
		},
	};
}

/** Reconstruct live `HsmmInputs` (incl. a rebuilt route graph) from a
 *  captured fixture, ready to feed straight into `decodeHsmm`. */
export function hsmmInputsFromFixture(captured: HsmmCapturedDay): HsmmInputs {
	const lines: RawOsmLine[] = captured.inputs.rawOsmLines.map((l) => ({ ...l, osm_id: BigInt(l.osm_id) }));
	const points: RawOsmPoint[] = captured.inputs.rawOsmPoints.map((p) => ({ ...p, osm_id: BigInt(p.osm_id) }));
	return {
		date: captured.meta.date,
		tz: captured.meta.tz,
		points: captured.inputs.points,
		hr: captured.inputs.hr,
		steps: captured.inputs.steps,
		sleep: captured.inputs.sleep,
		places: captured.inputs.places,
		placeNearLine: new Set(captured.inputs.placeNearLine),
		routeGraph: buildRouteGraph(lines, points),
		continuityContext: captured.inputs.continuityContext,
		proximityByMinute: new Map(captured.inputs.proximityByMinute),
		railStopRelations: captured.inputs.railStopRelations,
		// The flags gate the decode itself. Leaving them undefined here is what
		// made the replay decode a different model from production's.
		...decodeFlagsFor(captured).flags,
	};
}
