/**
 * Classification-snapshot harness.
 *
 * The committable, no-DB, no-network safety net for the scored-classification
 * migration (#103). The real regression corpus (`tests/golden/`) carries real
 * coordinates and biometrics, so it is gitignored and never runs in CI — which
 * means *nothing* exercises the classification cascade on every commit. This
 * harness fills that gap with synthetic days: it assembles a full
 * `ClassificationInputs` closure from a `SynthDay` + a mock OSM adapter, runs
 * the pure `computeVelocityFromInputs` core, and projects the result down to
 * the per-segment `(mode, wayName)` sequence a test pins with an inline
 * snapshot.
 *
 * The snapshot is an *instrument*, not a correctness oracle: it freezes what
 * the pipeline emits today so that flipping `USE_FACTOR_SCORER` (or any
 * classification change) surfaces as an explicit, reviewable diff at the
 * segment level — the layer the factor scorer actually moves, finer-grained
 * than the state timeline the golden harness diffs.
 */

import type { ClassificationInputs } from "../../src/geo/classification-inputs.js";
import type { OsmAdapter } from "../../src/geo/osm-adapter.js";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import type { SynthDay } from "../scenarios/synth-day.js";

export interface SynthInputsOptions {
	/** Local date `YYYY-MM-DD` in `tz`. Default `2026-06-01`. */
	date?: string;
	/** IANA timezone for the day. Default `Europe/London`. */
	tz?: string;
}

/**
 * Wrap a {@link SynthDay} + OSM adapter into the `ClassificationInputs`
 * closure `computeVelocityFromInputs` consumes. Everything the synthetic
 * scenarios don't exercise (known places, HSMM decode, rail/bus caches,
 * sleep windows, empty-day bracket) is left empty — the day is defined
 * entirely by its GPS + biometric streams and what the adapter serves.
 */
export function synthInputs(synth: SynthDay, osm: OsmAdapter, opts: SynthInputsOptions = {}): ClassificationInputs {
	const tz = opts.tz ?? "Europe/London";
	const today = synth.points.map((p) => ({
		ts: p.ts,
		lat: p.lat,
		lon: p.lon,
		altitude: null,
		// Raw PhoneTrack fixes don't carry a derived speed; the Kalman
		// layer recomputes velocity from position. Leaving speed null
		// mirrors the prod loader's projection for synth points.
		speed: null,
		accuracy: p.accuracy,
		battery: null,
	}));
	return {
		identity: { userId: "synth", date: opts.date ?? "2026-06-01", displayTz: tz },
		phonetrack: { today, morning: [], priorEvening: [] },
		knownPlaces: [],
		biometrics: { hr: synth.hr, sleep: synth.sleep, steps: synth.steps },
		modeBiometrics: [],
		hsmmDecode: null,
		railRouteCache: [],
		osm,
		homeTz: tz,
		sleepWindows: [],
		emptyDayBracket: null,
	};
}

/**
 * Project the pipeline's segments to the stable snapshot shape: one line
 * per segment, `mode` (with `base→refined` when refinement changed it)
 * followed by the way/line label when present. This is what tests pin.
 */
export function segmentSnapshot(segments: readonly EnrichedSegment[]): string[] {
	return segments.map((s) => {
		const effective = s.refinedMode ?? s.mode;
		const mode = s.refinedMode && s.refinedMode !== s.mode ? `${s.mode}→${effective}` : effective;
		return s.wayName ? `${mode} · ${s.wayName}` : mode;
	});
}
