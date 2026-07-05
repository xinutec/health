/**
 * Per-state emission log-likelihood for the MVP HMM.
 *
 * `p(O_t | s) = p_gps_present(present | s)
 *              · p_speed(speed | s)
 *              · p_hr(hr | s)
 *              · p_cadence(cadence | s)`
 *
 * Conditional independence across modalities is an assumption — the
 * HMM design (`docs/archive/2025-model-hmm.md`) calls this out as
 * adequate in practice. State already encodes the latent cause, so
 * the modalities are correlated only via state. Cross-modality
 * correlation (e.g. GPS-absent ↔ HR-still-present in a tunnel) is
 * captured by the state-specific Bernoulli `p_gps_present(s)`.
 *
 * Per-mode prior calibration (hand-tuned for MVP; mixture emissions
 * and EM-fit per-state distributions are post-MVP per the proposal
 * "what MVP defers" list):
 *
 *   - **stationary**: speed ~ 0 (σ=2), HR ~ 70 (σ=15), cadence ~ 0
 *     (zero-inflated). GPS-present probability 0.95 (rare missing
 *     fixes when sitting outdoors with the phone).
 *   - **walking**: speed ~ 5 (σ=2), HR ~ 100 (σ=20), cadence ~ 100
 *     (σ=25). GPS-present 0.95.
 *   - **cycling**: speed ~ 18 (σ=6), HR ~ 130 (σ=20), cadence ~ 0
 *     (zero-inflated). GPS-present 0.95.
 *   - **driving**: speed ~ 40 (σ=20), HR ~ 75 (σ=15), cadence = 0.
 *     GPS-present 0.9.
 *   - **train**: speed ~ 50 (σ=30), HR ~ 75 (σ=15), cadence = 0.
 *     GPS-present 0.3 (often in tunnels; the LOW present-prob is
 *     the disambiguating signal vs driving for the Met-Line-under-
 *     Euston-Underpass case).
 *   - **plane**: speed ~ 600 (σ=200), HR ~ 70 (σ=15), cadence = 0.
 *     GPS-present 0.7.
 *   - **unknown**: uniform-ish very-low priors — explicitly weaker
 *     than any positive-evidence state. Used as a backstop so the
 *     decoder never falls through to NaN; in practice rarely the
 *     MAP because positive-evidence states always score higher.
 *
 * Missing biometric inputs (null) skip that factor — they don't
 * penalise. This matches the "Fitbit on charger" case: HR missing
 * shouldn't make walking less likely.
 *
 * Pure function. Place / line geometry terms (p(gps_lat,lon | place)
 * + p(gps | line)) are post-MVP — wired at integration time when
 * the per-place coordinates and per-line geometry are available.
 */

import { type ContinuityContext, continuityLogLikelihood } from "./factors/presence-continuity.js";
import type { LearnedEmissionParameters } from "./fit-emissions.js";
import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export type EmissionLogProbFn = (state: State, obs: Observation) => number;

export interface BuildEmissionFnOpts {
	/** focus_places coordinates keyed by place id. When provided,
	 *  `stationary @ placeId` states gain a place-distance emission
	 *  term: log Gaussian of distance from the observation's GPS fix
	 *  to the place's centroid, with σ = `PLACE_RADIUS_M`. When the
	 *  observation has no GPS fix, the term contributes nothing.
	 *
	 *  Without this, `stationary @ Home` and `stationary @ Work` and
	 *  `train @ Metropolitan Line` all score identically on a
	 *  GPS-null minute, which collapses the HMM's ability to attribute
	 *  the minute to the right state. */
	placeCoords?: ReadonlyMap<number, { lat: number; lon: number }>;

	/** Phase 2: learned per-mode emission distributions fit from
	 *  heuristic-labeled minutes. When provided, the per-mode
	 *  parameters in `learnedEmissions.perMode[mode]` OVERRIDE the
	 *  hand-tuned `MODE_PRIORS[mode]`. Modes flagged `"fallback"`
	 *  (insufficient training data) continue to use `MODE_PRIORS`.
	 *  All non-mode-specific terms (place-distance, time-of-day,
	 *  off-network log-prior) are unaffected.
	 *
	 *  Loaded via the `learned_hmm_models` table; see
	 *  `docs/proposals/2026-05-hmm-learned-emissions.md`. */
	learnedEmissions?: LearnedEmissionParameters;

	/** Phase 3 of `docs/proposals/2026-06-presence-continuity.md`. When
	 *  present, the no-fix-evidence emission factor adds a positive
	 *  log-bonus for the `stationary @ priorPlaceId` state, decaying
	 *  with `hoursSinceLastConfirmedFix`. Pulls the HSMM toward the
	 *  continuation candidate when nothing contradicts it.
	 *  Computed once per day from `presence_log[date - 1]`; callers
	 *  set this to `null` when continuity is disabled (the feature
	 *  flag is off, or no prior-day record exists). */
	continuityContext?: ContinuityContext | null;
}

/** σ for the place-centroid Gaussian. Matches the
 *  `STAY_RADIUS_M = 150` used elsewhere in the pipeline — a fix
 *  more than ~3σ away from a place is essentially "not at that
 *  place." */
const PLACE_RADIUS_M = 150;

/** Floor on the place-distance log-penalty — heavy-tailed Gaussian
 *  approximation reflecting realistic GPS noise. A pure Gaussian
 *  with σ=150m would penalise a 5km-away fix by −555 nats (hard
 *  zero), but GPS noise in the real world has heavy tails:
 *  cell-tower fallback fixes 1-3km off, jammed indoor receivers 5km+
 *  outliers, occasional rogue triangulations entirely wrong. The
 *  floor models the tail probability of a fix being wildly off
 *  (≈1% × log) so the HMM weighs a single rogue fix evidentially
 *  rather than letting it veto a high-prior place. */
const PLACE_DISTANCE_FLOOR = -3;

/** Hyper-prior on per-place HR for stationary @ known-place states
 *  that don't have a per-place fit (insufficient training data).
 *  Wide resting baseline. NOT the per-mode learned distribution,
 *  which pools all stationary minutes and is dominated by Work-
 *  elevated-HR data (μ≈75), making unfitted places spuriously
 *  beat fitted places like Home (μ≈69) at HR=75. */
const HYPER_PLACE_HR_MEAN = 70;
const HYPER_PLACE_HR_STD = 15;

/** Sleep-state HR override. When `obs.inBed === true`, the user's
 *  HR is dominated by their asleep / resting baseline (typically
 *  55-65bpm), not by per-place patterns — your sleep HR doesn't
 *  depend on which bed. Without this override, per-place HR fits
 *  trained on daytime visits (Home μ=69) get beaten by
 *  whichever rare place happens to have been visited at sleep
 *  times (e.g. a hotel stay during travel; μ=64 from those
 *  overnight minutes), causing overnight place-bouncing. The
 *  sleep override re-anchors place attribution at rest. */
const ASLEEP_HR_MEAN = 58;
const ASLEEP_HR_STD = 10;

/** Fixed log-prior for the off-network stationary state when the
 *  observation has a GPS fix. Calibrated against the floored
 *  place-distance penalty so:
 *    - A fix near (≲ 200 m of) a known place's centroid scores
 *      higher under `stationary @ knownPlace` than under
 *      `stationary @ none`.
 *    - A fix far (≳ 300 m) from all known places scores higher
 *      under `stationary @ none` than under any `stationary @
 *      knownPlace`.
 *  -2 nats fits between PLACE_DISTANCE_FLOOR (-3, the asymptote
 *  for very-distant fixes) and the near-centroid score (~-0.2).
 *  Crossover at z ≈ 2 → d ≈ 300 m. */
const OFF_NETWORK_LOG_PRIOR = -2;

interface ModePrior {
	gpsPresentProb: number; // P(gps fix present | mode)
	speedMean: number;
	speedStd: number;
	hrMean: number;
	hrStd: number;
	// Cadence: zero-inflated. positiveMean/Std apply when cadence > 0.
	// expectedZeroProb is the probability of an explicit-zero
	// observation under this mode (high for moving-but-not-walking;
	// low for walking).
	expectedZeroProb: number;
	cadencePositiveMean: number;
	cadencePositiveStd: number;
}

// GPS-presence as a per-mode Bernoulli was found in the Phase 1.5
// audit to be net-harmful: it can't distinguish "phone charging at
// home (GPS off)" from "deep in a tube tunnel (GPS off)" without
// per-(mode, place, time) conditioning that's out of MVP scope.
// Setting it to a uniform value across all modes makes GPS-absence
// inert — the per-minute decision falls to HR + speed + cadence +
// place-distance, which are actually discriminative.
const UNIFORM_GPS_PRESENT_PROB = 0.85;

/** Per-minute log P(mode) prior — the unconditional rate at which
 *  the user is in each mode across all hours of the day. Applied
 *  per-minute regardless of other evidence. Stationary dominates
 *  because that's the empirical reality: most life-minutes are
 *  spent in one place.
 *
 *  Why per-minute here (and NOT also per-place): the per-place
 *  hour-of-day choice fires once per segment at entry — see
 *  `entry-prior.ts`. The mode-level rate is independent of the
 *  specific place and applies every minute. It restores the
 *  "stay continuation" pressure that the per-minute hour-of-day
 *  boost was incidentally providing before the entry-prior move
 *  (post-move the HSMM over-classified daytime stays as movement
 *  because nothing pulled per-minute toward stationary).
 *
 *  Empirical: pippijn's life is ~70% stationary (Home/Work/Clinic),
 *  ~10% walking, ~5% train, occasional driving, rare cycling/plane.
 *  Sums roughly to 1; we don't strictly normalise because the
 *  log-likelihood scoring is unaffected by global constants. */
const MODE_PRIOR_LOG: Record<State["mode"], number> = {
	stationary: Math.log(0.7),
	walking: Math.log(0.1),
	cycling: Math.log(0.01),
	driving: Math.log(0.02),
	train: Math.log(0.05),
	plane: Math.log(0.005),
	unknown: Math.log(0.1),
};

/** P(Fitbit-tracked sleep at this minute | mode) — a soft factor
 *  applied per-minute when `obs.inBed === true`. Calibrated such
 *  that combined across a typical overnight (~480 minutes asleep):
 *  walking gets ~-3300 nats cumulative penalty (effectively
 *  impossible), train ~-576 nats (strong but overridable), plane
 *  ~-336 nats (overridable by clear in-flight evidence). When
 *  `inBed === false` the factor is not applied — absence of a
 *  Fitbit sleep record carries no information (sleep tracking only
 *  fires during detected sleep sessions). */
const IN_BED_PROB_BY_MODE: Record<State["mode"], number> = {
	stationary: 0.99, // overwhelming: bed implies stationary
	walking: 0.0001, // sleepwalking is rare, brief
	cycling: 0.0001, // not physically possible
	driving: 0.0001, // would crash
	train: 0.1, // commute nap / sleeper train — uncommon overnight
	plane: 0.3, // long-haul sleep — happens but not every minute
	// `unknown` represents "we couldn't classify the minute" — it
	// should fire during data gaps, NOT during sleep. When in bed,
	// the user is in a real state (stationary almost always); they
	// shouldn't be in `unknown`. Strongly penalised so it can't be
	// used as a 1-minute bridge between distant stationary places
	// during sleep (the dominant overnight-bouncing pathology).
	unknown: 0.05,
};

const MODE_PRIORS: Record<State["mode"], ModePrior> = {
	stationary: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 0,
		speedStd: 2,
		hrMean: 70,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 10,
		cadencePositiveStd: 20,
	},
	walking: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 5,
		speedStd: 2,
		hrMean: 100,
		hrStd: 20,
		expectedZeroProb: 0.05,
		cadencePositiveMean: 100,
		cadencePositiveStd: 25,
	},
	cycling: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 18,
		speedStd: 6,
		hrMean: 130,
		hrStd: 20,
		expectedZeroProb: 0.95,
		cadencePositiveMean: 30,
		cadencePositiveStd: 30,
	},
	driving: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 40,
		speedStd: 20,
		hrMean: 75,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	train: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 50,
		speedStd: 30,
		hrMean: 75,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	plane: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 600,
		speedStd: 200,
		hrMean: 70,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	unknown: {
		// Weak uniform-ish backstop. Drawn to always lose to a
		// positive-evidence state in head-to-head scoring.
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 20,
		speedStd: 200, // very wide → always low density per data point
		hrMean: 80,
		hrStd: 100,
		expectedZeroProb: 0.5,
		cadencePositiveMean: 50,
		cadencePositiveStd: 100,
	},
};

const LOG_2PI = Math.log(2 * Math.PI);

/** log of Gaussian pdf at value x with mean μ and std σ. */
function logNormalPdf(x: number, mu: number, sigma: number): number {
	if (sigma <= 0) return Number.NEGATIVE_INFINITY;
	const z = (x - mu) / sigma;
	return -0.5 * z * z - Math.log(sigma) - 0.5 * LOG_2PI;
}

function logBernoulli(present: boolean, pPresent: number): number {
	if (pPresent <= 0) return present ? Number.NEGATIVE_INFINITY : 0;
	if (pPresent >= 1) return present ? 0 : Number.NEGATIVE_INFINITY;
	return Math.log(present ? pPresent : 1 - pPresent);
}

/** Zero-inflated cadence log-pdf. */
function logCadencePdf(cadence: number, prior: ModePrior): number {
	if (cadence === 0) return Math.log(prior.expectedZeroProb);
	// Positive cadence: mix the (1 - expectedZeroProb) mass over the
	// positive-cadence Gaussian.
	const positiveMix = Math.log(1 - prior.expectedZeroProb);
	return positiveMix + logNormalPdf(cadence, prior.cadencePositiveMean, prior.cadencePositiveStd);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildEmissionFn(opts: BuildEmissionFnOpts = {}): EmissionLogProbFn {
	const places = opts.placeCoords ?? null;
	const learned = opts.learnedEmissions ?? null;
	const perPlaceHr = learned?.perPlaceHr ?? null;
	const continuity = opts.continuityContext ?? null;

	// Pre-resolve effective per-mode priors: for each mode, either a
	// learned fit (when `learnedEmissions.perMode[mode]` is present and
	// not `"fallback"`) or the hand-tuned `MODE_PRIORS[mode]`. Done once
	// at build time so the hot per-minute closure doesn't re-decide.
	//
	// Note: `gpsPresentProb` is NOT taken from the learned model — it
	// stays at the hand-tuned `UNIFORM_GPS_PRESENT_PROB`. Per-mode
	// learning of GPS-presence reintroduces the Phase 1.5 problem: a
	// per-minute log-ratio of 1-2 nats favouring stationary at every
	// GPS-null minute (because the heuristic confounds "indoor" with
	// "stationary," making stationary's learned gpsPresentProb tend
	// toward ~0.1). That accumulates over 500+ GPS-null minutes/day
	// into hundreds of nats of "stationary" pressure, swamping the
	// real per-minute mode discrimination.
	const effectivePriors: Record<State["mode"], ModePrior> = { ...MODE_PRIORS };
	if (learned !== null) {
		for (const mode of Object.keys(MODE_PRIORS) as State["mode"][]) {
			const fit = learned.perMode[mode];
			if (fit === undefined || fit === "fallback") continue;
			effectivePriors[mode] = {
				gpsPresentProb: MODE_PRIORS[mode].gpsPresentProb, // KEEP hand-tuned
				speedMean: fit.speed.mean,
				speedStd: fit.speed.std,
				hrMean: fit.hr.mean,
				hrStd: fit.hr.std,
				expectedZeroProb: fit.cadence.expectedZeroProb,
				cadencePositiveMean: fit.cadence.positiveMean,
				cadencePositiveStd: fit.cadence.positiveStd,
			};
		}
	}

	return (state: State, obs: Observation): number => {
		const prior = effectivePriors[state.mode];
		let logProb = 0;

		// Per-minute mode prior — `log P(mode)` independent of evidence.
		// Stationary is the default daytime state; movement modes need
		// positive evidence to overcome the prior. See MODE_PRIOR_LOG.
		logProb += MODE_PRIOR_LOG[state.mode];

		// Presence-continuity bonus — Phase 3 of the continuity proposal.
		// Silent under default (continuity null); under continuation it
		// gives a positive log-bonus to `stationary @ priorPlaceId` on
		// no-fix minutes, decaying with time-since-last-fix.
		if (continuity !== null) {
			logProb += continuityLogLikelihood(state, obs, continuity);
		}

		// GPS-present Bernoulli — fires every minute.
		logProb += logBernoulli(obs.gps !== null, prior.gpsPresentProb);

		// Speed: only if GPS present (no speed without a fix).
		if (obs.gps !== null) {
			logProb += logNormalPdf(obs.gps.speedKmh, prior.speedMean, prior.speedStd);
		} else if (state.mode === "plane") {
			// GPS-null cannot reasonably indicate plane — being in the
			// air is exactly when GPS is most LIKELY to be present
			// (clear sky view; flight-mode toggles aside). Without
			// this penalty, the HMM uses `plane` as a 1-minute
			// teleport bridging `stationary @ A → plane → stationary
			// @ B` to bypass the stationary→stationary hard-zero, and
			// cycles through 7+ near-Home focus places overnight
			// (visible in the Phase 2.5 side-by-side render). A
			// strong negative on GPS-null forces the HMM to prefer
			// walking or a slower bridge.
			logProb += -8;
		}

		// HR: only if HR sample present (missing HR doesn't penalise
		// any mode — the Fitbit-on-charger case). Per-place HR fit
		// (Phase 2.5: a clinic visit's HR baseline differs from Home's)
		// overrides the per-mode HR when the state is
		// `stationary @ knownPlace` AND a per-place fit exists.
		//
		// For stationary @ knownPlace WITHOUT a per-place fit, use a
		// hyper-prior (wide resting baseline) rather than inheriting
		// the per-mode learned distribution. Per-mode-learned is
		// pooled across all stationary minutes — dominated by
		// Work/Stay minutes with elevated HR — so it'd score HR=75
		// HIGHER for an unfitted place than for Home with its
		// per-place fit at μ=69. The hyper-prior reflects "we don't
		// know this place's typical HR; assume wide resting."
		if (obs.hr !== null) {
			let hrMean = prior.hrMean;
			let hrStd = prior.hrStd;
			if (state.mode === "stationary" && state.placeId !== null) {
				if (obs.inBed) {
					// At sleep, P(HR | place X) ≈ P(HR | asleep) regardless of X.
					// Use the universal asleep-HR distribution so place
					// attribution falls to the other factors (visit-frequency
					// init prior + place-distance) rather than per-place HR
					// idiosyncrasies from limited training data.
					hrMean = ASLEEP_HR_MEAN;
					hrStd = ASLEEP_HR_STD;
				} else {
					const fit = perPlaceHr !== null ? perPlaceHr[String(state.placeId)] : undefined;
					if (fit !== undefined) {
						hrMean = fit.mean;
						hrStd = fit.std;
					} else {
						// Hyper-prior for known place with no per-place fit.
						hrMean = HYPER_PLACE_HR_MEAN;
						hrStd = HYPER_PLACE_HR_STD;
					}
				}
			}
			logProb += logNormalPdf(obs.hr, hrMean, hrStd);
		}

		// Cadence: only if step row present (null means "no row
		// written" — informational, but not a penalty).
		if (obs.cadence !== null) {
			logProb += logCadencePdf(obs.cadence, prior);
		}

		// Sleep-state factor — soft, calibrated per-mode evidence.
		// Fires per-minute when Fitbit reports the user is in a
		// sleep stage at this minute (asleep/light/deep/rem, or even
		// a brief "wake" within a sleep session — all imply "in bed").
		// Composes multiplicatively (additively in log) so the
		// joint penalty over a full overnight stretch is decisive
		// for walking/cycling/driving but only moderate for
		// train/plane (where sleeping is plausible). NEVER a hard
		// constraint — strong evidence can still override.
		if (obs.inBed) {
			logProb += Math.log(IN_BED_PROB_BY_MODE[state.mode]);
		}

		// Place-distance emission for stationary states. Without this
		// term, the HMM has no way to attribute a stationary GPS fix
		// to the right focus place — all `stationary @ placeId`
		// states emit identically on the non-geometric signals, and
		// the decoder falls back to whatever the transition prior
		// prefers (often the wrong place).
		//
		// Peak-normalised score: 0 at the centroid, -0.5·(d/σ)² away.
		// `stationary @ none` gets a fixed log-prior — see
		// `OFF_NETWORK_LOG_PRIOR`. Together: a fix close to a known
		// place scores higher there; a fix far from all known places
		// scores higher under `none`.
		//
		// Only applies when GPS is present (no place attribution
		// without observation).
		if (state.mode === "stationary" && places !== null && obs.gps !== null) {
			if (state.placeId !== null) {
				const placeCoord = places.get(state.placeId);
				if (placeCoord !== undefined) {
					const d = haversineMeters(obs.gps.lat, obs.gps.lon, placeCoord.lat, placeCoord.lon);
					const z = d / PLACE_RADIUS_M;
					logProb += Math.max(PLACE_DISTANCE_FLOOR, -0.5 * z * z);
				}
			} else {
				logProb += OFF_NETWORK_LOG_PRIOR;
			}
		}

		return logProb;
	};
}
