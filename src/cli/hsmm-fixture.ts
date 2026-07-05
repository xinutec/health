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
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint } from "../geo/route-graph.js";
import type { HsmmInputs, HsmmPlace } from "../hmm/decode.js";
import type { ContinuityContext } from "../hmm/factors/presence-continuity.js";
import type { HmmSegment } from "../hmm/persist.js";

export const HSMM_FIXTURE_FORMAT_VERSION = 1;

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
	};
}
