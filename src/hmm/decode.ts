/**
 * Pure HSMM decode core — the deterministic boundary for the joint
 * day-decoder, mirroring `computeVelocityFromInputs` on the velocity
 * side (Phase 7 of `docs/proposals/2026-06-deterministic-fixtures.md`).
 *
 * `decodeHsmm(inputs)` takes a fully-loaded `HsmmInputs` (row-sets +
 * route graph + prior-day continuity context) and returns the decoded
 * segments. No DB, no network, no globals, no feature-flag reads — given
 * the same inputs it always produces the same decode. The production
 * cron and the `decode-day` CLI load the inputs and persist the result
 * around this core; tests call it directly against a captured fixture so
 * the decode is replayable without a database.
 *
 * The flag gate (`useContinuityContinuation`) lives in the loader, not
 * here: the loader either reads the prior-day continuity context or
 * passes `null`, and this core consumes whatever it is handed.
 */

import type { HrPoint, SleepStageRecord, StepPoint } from "../geo/biometrics.js";
import type { FilteredPoint } from "../geo/kalman.js";
import type { RailStopRelation } from "../geo/osm-rail-stops.js";
import type { RouteGraph } from "../geo/route-graph.js";
import { buildChainContext } from "./chain-context.js";
import { DEFAULT_MIN_DURATION_BY_MODE, type GammaFit } from "./duration-dist.js";
import { buildEmissionFn } from "./emissions.js";
import { buildEntryPrior } from "./entry-prior.js";
import type { ContinuityContext } from "./factors/presence-continuity.js";
import { buildGeometricFeasibility } from "./geometric-feasibility.js";
import { dropGpsOutliers } from "./gps-outliers.js";
import { hsmmViterbi } from "./hsmm-viterbi.js";
import { buildInitialStatePrior } from "./initial-state.js";
import { buildLineProximityFactor } from "./line-proximity-factor.js";
import type { Observation } from "./observation.js";
import { buildObservationTensor } from "./observation.js";
import { groupStatesIntoSegments, type HmmSegment } from "./persist.js";
import { buildRouteRailEvidence } from "./route-rail-evidence.js";
import { buildSegmentEvidence } from "./segment-evidence.js";
import { buildStateSpace, type FocusPlaceRef, type State } from "./state-space.js";
import { resolveStationChain } from "./station-chain.js";
import { buildTrainGeneratorPrior } from "./train-generator-prior.js";
import { buildDurationLogProb } from "./train-hop-duration.js";
import { buildTransitionMatrix } from "./transitions.js";

/** Tube lines the decoder models as named `train @ line` states. Fixed
 *  decode config — shared with the CLI's `placeNearLine` build so the
 *  state space and the place-line adjacency agree. */
export const KNOWN_LINES = [
	"Metropolitan Line",
	"Jubilee Line",
	"Victoria Line",
	"Piccadilly Line",
	"Bakerloo Line",
	"Northern Line",
	"Circle Line",
	"Hammersmith & City Line",
	"District Line",
	"Central Line",
	"Elizabeth Line",
];

/** Baseline per-mode Gamma fits — moments-matched on 45 days of
 *  training data. Shared with `compare-vs-ground-truth.ts`; both the
 *  decoder and the comparison CLI need identical fits to produce
 *  identical decodes. Eventually these become persisted rows in
 *  `learned_hmm_models`. */
export const BASELINE_DURATION_FITS: Record<State["mode"], GammaFit> = {
	stationary: { alpha: 0.85, beta: 0.0043, sampleCount: 132 },
	walking: { alpha: 1.07, beta: 0.034, sampleCount: 60 },
	cycling: { alpha: 1.0, beta: 0.05, sampleCount: 0 },
	driving: { alpha: 0.42, beta: 0.008, sampleCount: 24 },
	train: { alpha: 1.74, beta: 0.053, sampleCount: 24 },
	plane: { alpha: 1.0, beta: 0.011, sampleCount: 0 },
	unknown: { alpha: 0.45, beta: 0.0034, sampleCount: 15 },
};

/** A focus place with the coordinates + priors the decoder needs:
 *  centroid for geometric feasibility, hour profile + dwell weight for
 *  the entry prior. */
export interface HsmmPlace extends FocusPlaceRef {
	lat: number;
	lon: number;
	hourProfile: readonly number[] | null;
	totalDwellSec: number;
}

/** Fully-loaded, bounded inputs to one day's decode. Every field is a
 *  concrete data value — no callbacks into the DB, no adapters. The
 *  loader (`loadHsmmInputs`) populates these; `decodeHsmm` consumes
 *  them. */
export interface HsmmInputs {
	/** Local-tz date string `YYYY-MM-DD`. */
	date: string;
	/** IANA timezone for the day's UTC window + local-clock priors. */
	tz: string;
	/** Kalman-filtered GPS fixes (pre-outlier-drop — `decodeHsmm` runs
	 *  the deterministic outlier filter itself). */
	points: readonly FilteredPoint[];
	hr: readonly HrPoint[];
	steps: readonly StepPoint[];
	sleep: readonly SleepStageRecord[];
	/** The user's focus places with decode priors. */
	places: readonly HsmmPlace[];
	/** Set of `${placeId}|${lineName}` pairs where the place is within
	 *  walking distance of a station on the line. */
	placeNearLine: ReadonlySet<string>;
	/** Lifetime rail route graph (bbox derived from focus places). */
	routeGraph: RouteGraph;
	/** Prior-day end-of-day continuity context, or null (chain start /
	 *  flag off / no prior row). */
	continuityContext: ContinuityContext | null;
	/** Rail/road proximity per minute, keyed by the minute's top-of-minute
	 *  ts (#238, from `computeMinuteProximity`) — lets the line-proximity
	 *  factor tell "riding the track" from "driving past it". Optional:
	 *  absent on inputs built before #238, in which case the road-vs-rail
	 *  test is skipped and the decode is unchanged. */
	proximityByMinute?: ReadonlyMap<number, { railDistM: number | null; roadDistM: number | null }>;
	/** C4.1 watch-liveness cadence imputation. Set by the LOADER from
	 *  `useCadenceImputation()` (this module stays flag-free and pure);
	 *  absent/false keeps the pre-C4.1 tensor. Carried in fixtures so a
	 *  replay reproduces the capture. */
	imputeCadence?: boolean;
	/** C4.2 segment-scoped physics evidence (net displacement / step
	 *  budget vs mode, `segment-evidence.ts`). Loader-set from
	 *  `useSegmentEvidence()`; absent/false keeps the prior decode. */
	segmentEvidence?: boolean;
	/** C4.2 exit→entry chain context (`chain-context.ts`): geometric
	 *  feasibility of every new-segment transition from the previous
	 *  segment's exit evidence. Loader-set from `useChainContext()`;
	 *  absent/false keeps the prior decode. */
	chainContext?: boolean;
	/** C4.2 reacquire-robust stationary speed (`emissions.ts`): widened
	 *  speed σ while the Kalman filter settles after a GPS blackout.
	 *  Loader-set from `useReacquireRobustSpeed()`; absent/false keeps
	 *  the prior decode. */
	reacquireRobustSpeed?: boolean;
	/** Mirrored rail route relations (`rail_stops_cache`, #364): the
	 *  served-station ground truth the station-chain resolver weighs
	 *  candidates with. Optional — absent (fixtures captured before the
	 *  field, an empty mirror) decodes unchanged. */
	railStopRelations?: readonly RailStopRelation[];
}

/** The assembled per-day model: the observation tensor, the state space,
 *  and the score callbacks exactly as the trellis consumes them. Split
 *  from `decodeHsmm` so the Lean shadow (`lean-shadow.ts`) quantises the
 *  very same model the production decode runs — never a re-derivation
 *  that could drift. */
export interface HsmmModel {
	tensor: readonly Observation[];
	states: readonly State[];
	transitionLogProb: (from: State, to: State, obs: Observation) => number;
	emissionLogProb: (state: State, obs: Observation) => number;
	initialLogProb: (state: State) => number;
	entryLogProb: (state: State, obs: Observation) => number;
	durationLogProb: (state: State, d: number, segEndIndex: number) => number;
}

/** Assemble one day's decode model. Pure: same inputs → same model. */
export function buildHsmmModel(inputs: HsmmInputs): HsmmModel {
	const cleanedPoints = dropGpsOutliers(inputs.points);
	const tensor = buildObservationTensor({
		date: inputs.date,
		tz: inputs.tz,
		points: cleanedPoints,
		hr: inputs.hr,
		steps: inputs.steps,
		sleep: inputs.sleep,
		proximityByMinute: inputs.proximityByMinute,
		imputeCadence: inputs.imputeCadence === true,
	});
	const states = buildStateSpace({ focusPlaces: inputs.places, knownLines: KNOWN_LINES });

	const placeCoords = new Map<number, { lat: number; lon: number }>();
	const placeHourProfiles = new Map<number, readonly number[]>();
	const placeVisitWeights = new Map<number, number>();
	const totalDwell = inputs.places.reduce((s, p) => s + p.totalDwellSec, 0);
	for (const p of inputs.places) {
		placeCoords.set(p.id, { lat: p.lat, lon: p.lon });
		if (p.hourProfile !== null) placeHourProfiles.set(p.id, p.hourProfile);
		placeVisitWeights.set(p.id, totalDwell > 0 ? p.totalDwellSec / totalDwell : 1 / inputs.places.length);
	}

	const transition = buildTransitionMatrix({
		states,
		placeNearLine: (placeId, lineName) => inputs.placeNearLine.has(`${placeId}|${lineName}`),
	});
	const baseEmission = buildEmissionFn({
		placeCoords,
		continuityContext: inputs.continuityContext,
		reacquireRobustSpeed: inputs.reacquireRobustSpeed === true,
	});
	const geometricFn = buildGeometricFeasibility({ placeCoords });
	// Train-generator soft prior (Phase 1, `decoder-roadmap.md`):
	// structural `(board, line, alight)` candidates become a per-segment entry
	// prior over `train @ L`, and `isCovered` gates the per-minute line factors
	// off where the generator is authoritative (no double-count).
	const trainGen = buildTrainGeneratorPrior({
		observations: tensor,
		routeGraph: inputs.routeGraph,
		knownLines: KNOWN_LINES,
	});
	const routeRailFn = buildRouteRailEvidence({ routeGraph: inputs.routeGraph, isCovered: trainGen.isCovered });
	const lineProximityFn = buildLineProximityFactor({ routeGraph: inputs.routeGraph, isCovered: trainGen.isCovered });
	const emission = (state: State, obs: Observation): number =>
		baseEmission(state, obs) + geometricFn(state, obs) + routeRailFn(state, obs) + lineProximityFn(state, obs);
	const initialLogProb = buildInitialStatePrior();
	const baseEntryLogProb = buildEntryPrior({ placeHourProfiles, placeVisitWeights });
	const entryLogProb = (state: State, obs: Observation): number =>
		baseEntryLogProb(state, obs) + trainGen.entry(state, obs);

	// Duration prior with the one-stop-hop relaxation: a generator-vouched
	// sub-floor train segment (GPS-occluded underground hop) escapes the
	// 2-minute movement floor. See `train-hop-duration.ts`. Multi-minute
	// trains and every other mode are unaffected — the golden corpus is
	// unchanged.
	const durationPrior = buildDurationLogProb({
		fits: BASELINE_DURATION_FITS,
		minByMode: DEFAULT_MIN_DURATION_BY_MODE,
		tsAt: (i) => tensor[i]?.ts,
		isTrainCovered: trainGen.isCovered,
	});
	// C4.2 segment physics (opt-in): net displacement + step budget scored
	// once per candidate segment, composed with the duration prior — the
	// duration hook is the one place the trellis knows a segment's full
	// window.
	const segEvidence = inputs.segmentEvidence === true ? buildSegmentEvidence({ observations: tensor }) : null;
	const durationLogProb =
		segEvidence === null
			? durationPrior
			: (state: State, d: number, segEndIndex: number): number =>
					durationPrior(state, d, segEndIndex) + segEvidence(state, d, segEndIndex);

	// C4.2 exit→entry chain context (opt-in): geometric feasibility of
	// each new-segment transition, composed with the static transition
	// prior — the transition hook is the one place the trellis knows
	// both the state being left and the state being entered.
	const chainFn =
		inputs.chainContext === true
			? buildChainContext({ placeCoords, routeGraph: inputs.routeGraph, isTrainCovered: trainGen.isCovered })
			: null;
	const transitionLogProb =
		chainFn === null
			? transition
			: (from: State, to: State, obs: Observation): number => {
					const t = transition(from, to);
					if (t === Number.NEGATIVE_INFINITY) return t;
					return t + chainFn(from, to, obs);
				};

	return {
		tensor,
		states,
		transitionLogProb,
		emissionLogProb: emission,
		initialLogProb,
		entryLogProb,
		durationLogProb,
	};
}

/**
 * Decode one day to HSMM segments. Pure: same inputs → same output.
 */
export function decodeHsmm(inputs: HsmmInputs): HmmSegment[] {
	const model = buildHsmmModel(inputs);
	const hmmStates = hsmmViterbi({
		observations: model.tensor,
		states: model.states,
		transitionLogProb: model.transitionLogProb,
		emissionLogProb: model.emissionLogProb,
		initialLogProb: model.initialLogProb,
		entryLogProb: model.entryLogProb,
		durationLogProb: model.durationLogProb,
	});
	return segmentsFromStates(model, hmmStates, inputs);
}

/**
 * Turn a decoded per-minute state path into labelled segments. The tail shared
 * by the TS float decode (`decodeHsmm`, path from `hsmmViterbi`) and the
 * verified Lean decode (`decodeHsmmViaLean`, path from the bridge): both produce
 * a state path over the SAME model, then tile and station-label it identically,
 * so the served output depends only on WHICH decoder produced the path, not on
 * two divergent segmentisers. Pure — no flags, no bridge.
 */
export function segmentsFromStates(model: HsmmModel, hmmStates: readonly State[], inputs: HsmmInputs): HmmSegment[] {
	const timestamps = model.tensor.map((o) => o.ts);
	const segments = groupStatesIntoSegments(hmmStates, timestamps);

	// C4.3 chained train triples: assign board/alight stations to the
	// decoded train legs, scored jointly along each journey chain
	// (`station-chain.ts`). Confidence-gated — an ambiguous side stays
	// null rather than guessing.
	const stations = resolveStationChain({
		segments,
		observations: model.tensor,
		routeGraph: inputs.routeGraph,
		railStopRelations: inputs.railStopRelations,
	});
	for (const [segIndex, resolved] of stations) {
		segments[segIndex].boardStation = resolved.board;
		segments[segIndex].alightStation = resolved.alight;
	}
	return segments;
}
