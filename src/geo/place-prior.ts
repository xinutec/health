/**
 * Probabilistic place assignment for stationary segments.
 *
 * Given a segment's spatial centroid and a list of candidate focus_places
 * (the user's mined long-term clusters), this module picks the most
 * likely place by combining:
 *
 *   - Log-likelihood on distance: a Gaussian centred at the place's
 *     stored centroid. σ is the place's empirical radius, floored to
 *     a GPS-noise tolerance — wide for an established place, tight for
 *     a sparse one (see the SIGMA_FLOOR_* constants). A fix two σ
 *     off-centre takes a -2 hit; five σ off is ~zero probability.
 *   - Log-prior on visit frequency: log(unique_days + 1). A place
 *     you've been to 200 times beats one you've been to once,
 *     all else equal.
 *   - Time-of-day match: the stay's own hour-of-day profile scored
 *     against each candidate's mined hour-of-day dwell profile
 *     (`focus_places.hour_profile`). Centred so a uniform — or null,
 *     un-mined — profile scores 0; a profile concentrated on the
 *     stay's hours scores positive, a profile that avoids them
 *     negative. Bounded like the frequency prior: it breaks ties
 *     between co-located candidates (a daytime café vs an evening
 *     residence ~100 m apart, which the distance term cannot
 *     separate) without overriding strong distance evidence. It
 *     generalises — and replaces — the old binary sleep/awake prior.
 *
 * `pickBestPlace` returns the argmax, or `null` when no candidate
 * crosses a posterior threshold. Callers fall through to OSM-amenity
 * lookup on null — that's the path for "you went somewhere new, the
 * place isn't in focus_places, so the amenity-lookup-from-OSM tells
 * us what kind of venue it is."
 */

import { haversineMeters } from "./place-snap.js";

export interface PlaceCandidate {
	id: number;
	centroidLat: number;
	centroidLon: number;
	/** Empirical scatter of the cluster — used as σ for the
	 *  distance Gaussian. Floored at SIGMA_FLOOR_M to avoid
	 *  pathologically narrow places. */
	radiusM: number;
	/** Distinct days this place has been visited. */
	uniqueDays: number;
	/** Hour-of-day dwell profile — 24 fractions summing to 1, keyed
	 *  by local solar hour. `null` for a place mined before the
	 *  column existed; the time-of-day term then contributes 0. */
	hourProfile: number[] | null;
}

/** The distance σ for the place-likelihood Gaussian is `radius_m`
 *  floored to a GPS-noise tolerance that the place has *earned* by
 *  being visited. The floor slides continuously between two bounds as
 *  visit-days accumulate — there is no hard "established / not" step.
 *
 *  `SIGMA_FLOOR_MAX_M` — the floor a thoroughly-established place
 *  converges to. focus_places.radius_m is the spread of the
 *  clustering centroid estimate (~25 m for a single building); the
 *  spread of day-of GPS fixes when a user is genuinely AT a place is
 *  much larger — indoor multipath, building corners, walking in and
 *  out. Production data shows day-of clusters routinely sit 100–200 m
 *  from a known place's centroid, so a place we are confident about
 *  gets a 100 m σ floor and the Gaussian doesn't collapse to ~0 for
 *  ordinary noise distances.
 *
 *  `SIGMA_FLOOR_MIN_M` — the floor for a place seen on a single day.
 *  It has earned no benefit of the doubt: a tight σ so it cannot
 *  capture a stay that merely falls in the same neighbourhood. With
 *  only the wide floor, the −8 posterior floor let even a once-visited
 *  place reach ~4σ ≈ 400 m and stamp its one-off mined label onto
 *  unrelated stays hundreds of metres away. NB this σ governs the
 *  distance-Gaussian SCORING and must stay generous enough that a
 *  low-visit lobe co-located with a busier one is still disambiguated
 *  by time-of-day rather than crushed on distance; the separate far-
 *  reach problem (a one-off claiming a stop 100+ m away) is handled by
 *  {@link ABS_VETO_REACH_MIN_M}, not by shrinking this floor. */
const SIGMA_FLOOR_MAX_M = 100;
const SIGMA_FLOOR_MIN_M = 40;

/** e-folding constant (in distinct visit-days) for how fast a place's
 *  σ floor climbs from MIN toward MAX. At `1 + TAU` visit-days the
 *  floor has closed ~63 % of the MIN→MAX gap. 10 days ⇒ a place
 *  visited a couple of weeks' worth of days is most of the way to the
 *  full established tolerance; a one-off sits at the minimum. */
const SIGMA_ESTABLISH_TAU_DAYS = 10;

/** Don't pick a place whose best score is worse than this many
 *  log-points below "fix sits exactly at the centroid + max
 *  frequency + time match". Roughly: distance > 4σ off + low
 *  history. Tuned by the regression tests. */
const POSTERIOR_FLOOR = -8;

/** Hard centroid-distance veto: a focus place is — by definition — a
 *  label for stays inside the cluster it was mined from. A stay more
 *  than this many σ from the centroid is geometrically outside the
 *  cluster, and the place's label does not apply, no matter how strong
 *  the visit-frequency or hour-of-day priors are. 3σ is the natural
 *  "essentially impossible to be from this cluster" boundary under the
 *  Gaussian. Without this gate, an established place — Work with 100+
 *  unique days, daytime hour profile — could win a stay 400 m away on
 *  priors alone (the 2026-05-22 Pizza-Union-as-Work bug). */
const MAX_DISTANCE_SIGMAS = 3;

/** Absolute cap (m) on the centroid-distance veto's reach for a place seen on
 *  a single day — independent of, and tighter than, its σ-derived 3σ reach. A
 *  one-off cluster sits at the SIGMA_FLOOR_MIN σ (40 m), giving a 3σ reach of
 *  120 m: far enough to let a place seen once (15 Feb) claim a stop 118 m away
 *  and stamp its mined label on it (2026-06-18 Wembley Park "Selekt Chicken").
 *  Capping a barely-known place's absolute reach closes that WITHOUT shrinking
 *  the distance-Gaussian σ (which scoring needs generous — see
 *  SIGMA_FLOOR_MIN_M). The cap climbs to {@link ABS_VETO_REACH_MAX_M} as
 *  visit-days accumulate; by ~2 days the 3σ reach is the binding limit again,
 *  so this only meaningfully constrains the genuinely once-seen place. */
const ABS_VETO_REACH_MIN_M = 90;
/** Effectively unbounded: above any established place's 3σ reach, so the cap
 *  never binds once a place has earned its σ. */
const ABS_VETO_REACH_MAX_M = 1000;

// --- Magnetic anchoring (2026-06-magnetic-focus-places.md) ---

/** Reference visit count for normalising magnet strength. A place with
 *  this many distinct visit-days gives $M_p \approx \log(11) \approx 2.4$ —
 *  enough to materially boost a near-tie but not enough to override
 *  strong distance evidence. */
const MAGNET_REF_DAYS = 10;

/** Base magnet radius (m) inside which a candidate can be boosted.
 *  Combined additively with the place's $\sigma$ so well-established
 *  places get a more generous range. */
const MAGNET_BASE_RADIUS_M = 30;

/** Multiplier on $\sigma_p$ in the magnet radius. With $\sigma_p$ up to
 *  100 m and $k = 2$, an established place's magnet reaches ~230 m. */
const MAGNET_SIGMA_MULTIPLIER = 2;

/** Veto-relaxation ceiling: even with maximal magnet × coherence, the
 *  veto cannot extend beyond this factor of the base $3\sigma$. Keeps
 *  the Gaussian-on-distance term in control — no infinite reach for any
 *  prior. */
const MAGNET_VETO_RELAX_MAX = 2.0;

/** The Gaussian σ a candidate effectively uses for distance scoring —
 *  `radiusM` floored to a GPS-noise tolerance that grows with how
 *  many distinct days the place has been visited. Shared between the
 *  scorer (smooth penalty) and the picker (hard veto) so both see the
 *  same notion of cluster size. */
function effectiveSigmaM(candidate: PlaceCandidate): number {
	const establishedness = 1 - Math.exp(-Math.max(0, candidate.uniqueDays - 1) / SIGMA_ESTABLISH_TAU_DAYS);
	const sigmaFloor = SIGMA_FLOOR_MIN_M + (SIGMA_FLOOR_MAX_M - SIGMA_FLOOR_MIN_M) * establishedness;
	return Math.max(sigmaFloor, candidate.radiusM);
}

/** Smoothing floor for the time-of-day term: every hour bucket is
 *  treated as carrying at least this much probability mass, so a stay
 *  whose hour never appears in a place's profile takes a bounded
 *  penalty rather than log(0). Sets the term's dynamic range. */
const HOUR_PROFILE_EPS = 0.02;

/** Time-of-day match between a candidate place and the stay being
 *  scored. Both arguments are hour-of-day dwell profiles (24 fractions
 *  summing to 1). The score is `Σ stay[h]·log(place[h]+ε)` re-centred
 *  by the uniform-profile baseline, so:
 *    - a uniform place — and a `null` (un-mined) place — score 0;
 *    - a place whose dwell concentrates on the stay's hours scores > 0;
 *    - a place that avoids the stay's hours scores < 0.
 *  The range is bounded (≈ [-1, +3]); it discriminates co-located
 *  candidates without overpowering the distance Gaussian. */
function hourProfileMatch(placeProfile: number[] | null, stayProfile: readonly number[]): number {
	if (placeProfile === null) return 0;
	const uniformLog = Math.log(1 / stayProfile.length + HOUR_PROFILE_EPS);
	let raw = 0;
	let stayTotal = 0;
	for (let h = 0; h < stayProfile.length; h++) {
		const w = stayProfile[h];
		if (w === 0) continue;
		stayTotal += w;
		raw += w * Math.log((placeProfile[h] ?? 0) + HOUR_PROFILE_EPS);
	}
	if (stayTotal === 0) return 0;
	return raw - stayTotal * uniformLog;
}

/** Magnet strength $M_p$ for a candidate. See
 *  `docs/proposals/2026-06-magnetic-focus-places.md` §1. Pure
 *  function of fields already on `PlaceCandidate`; bounded so
 *  Home doesn't drown out everything else. */
export function magnetStrength(candidate: PlaceCandidate): number {
	return Math.log(1 + candidate.uniqueDays);
}

/** Magnet radius around a focus_place. A candidate further than this
 *  from the segment centroid gets no magnet boost. Scales with the
 *  place's empirical scatter — a tightly-clustered place has a tight
 *  magnet, a well-established one a wider one. */
function magnetRadiusM(candidate: PlaceCandidate): number {
	return MAGNET_BASE_RADIUS_M + MAGNET_SIGMA_MULTIPLIER * effectiveSigmaM(candidate);
}

export function scorePlaceForSegment(
	candidate: PlaceCandidate,
	segCentroidLat: number,
	segCentroidLon: number,
	options: { stayHourProfile: readonly number[]; biometricCoherence?: number },
): number {
	const distM = haversineMeters(candidate.centroidLat, candidate.centroidLon, segCentroidLat, segCentroidLon);
	// The GPS-noise σ floor is earned, continuously: a place's tolerance
	// climbs from MIN toward MAX as distinct visit-days accumulate, with
	// no hard "established" step. A one-off place sits at the minimum
	// and cannot reach far past its own footprint; a place visited over
	// many days converges on the full tolerance.
	const sigma = effectiveSigmaM(candidate);
	// log-likelihood under Gaussian, constant terms dropped (we argmax).
	const logLikelihood = -(distM * distM) / (2 * sigma * sigma);

	// Prior on visit frequency. log(unique_days + 1) so the prior is
	// well-defined for never-visited places (log(1) = 0) and grows
	// gently — log-linear, so a place visited 500 times beats one
	// visited 5 times by log(500)-log(5) ≈ 4.6 points, which can be
	// outweighed by ~3σ of distance evidence. That's the right
	// tradeoff: lots of prior loses to strong distance evidence.
	const logPriorFreq = Math.log(candidate.uniqueDays + 1);

	// Time-of-day match against the place's mined hour-of-day profile.
	const logPriorTimeOfDay = hourProfileMatch(candidate.hourProfile, options.stayHourProfile);

	// Magnetic anchoring boost: place a strong recurring place under a
	// noisy-GPS visit, modulated by whether the segment's biometrics
	// agree the user is actually sitting. Inside the magnet radius
	// AND with positive biometric coherence → boost; otherwise zero.
	// See `docs/proposals/2026-06-magnetic-focus-places.md` §2.
	const Bs = options.biometricCoherence ?? 0;
	const insideMagnet = distM <= magnetRadiusM(candidate);
	const magnetBoost = insideMagnet ? magnetStrength(candidate) * Bs : 0;

	return logLikelihood + logPriorFreq + logPriorTimeOfDay + magnetBoost;
}

/** Pick the focus_place with the highest posterior score, or
 *  `null` when the best candidate's score is below the floor
 *  (typically: every candidate is too far away). */
export function pickBestPlace(
	candidates: readonly PlaceCandidate[],
	segCentroidLat: number,
	segCentroidLon: number,
	options: { stayHourProfile: readonly number[]; biometricCoherence?: number },
): { winner: PlaceCandidate; score: number } | null {
	if (candidates.length === 0) return null;
	let best: { winner: PlaceCandidate; score: number } | null = null;
	for (const c of candidates) {
		const s = scorePlaceForSegment(c, segCentroidLat, segCentroidLon, options);
		// Hard centroid-distance veto BEFORE the argmax: a candidate
		// whose centroid is outside MAX_DISTANCE_SIGMAS · σ from the
		// stay is geometrically outside its cluster and cannot be the
		// label, regardless of how high it would have scored on priors.
		// Filtering here (rather than after the argmax) lets a closer
		// in-cluster candidate still win when the far one would have
		// otherwise topped the list.
		const dist = haversineMeters(c.centroidLat, c.centroidLon, segCentroidLat, segCentroidLon);
		// Veto-relaxation under high magnet × coherence: an established
		// place with biometric agreement earns headroom on the distance
		// gate. Bounded so the Gaussian-on-distance term stays in
		// control — a candidate further than 2× the base 3σ never
		// passes, regardless of how strong its prior is. AND the
		// candidate must sit within its own magnet radius — outside
		// it the magnet contributes nothing anyway, so relaxing the
		// veto there would let a heavily-visited place steal a stay
		// hundreds of metres away (the 2026-05-22 Pizza-Union-as-Work
		// shape). See `docs/proposals/2026-06-magnetic-focus-places.md`
		// §"Note on the distance veto".
		const Bs = options.biometricCoherence ?? 0;
		const insideMagnet = dist <= magnetRadiusM(c);
		const magnetFactor = insideMagnet
			? Math.min(MAGNET_VETO_RELAX_MAX, 1 + (magnetStrength(c) * Bs) / MAGNET_REF_DAYS)
			: 1;
		// Absolute far-reach cap: a barely-visited place hasn't earned a long
		// reach even though its σ floor gives it one. Climbs with visit-days,
		// so it only meaningfully binds for the once-seen case.
		const establishedness = 1 - Math.exp(-Math.max(0, c.uniqueDays - 1) / SIGMA_ESTABLISH_TAU_DAYS);
		const absCap = ABS_VETO_REACH_MIN_M + (ABS_VETO_REACH_MAX_M - ABS_VETO_REACH_MIN_M) * establishedness;
		const vetoReach = Math.min(MAX_DISTANCE_SIGMAS * effectiveSigmaM(c) * magnetFactor, absCap);
		if (dist > vetoReach) continue;
		if (!best || s > best.score) best = { winner: c, score: s };
	}
	if (best && best.score < POSTERIOR_FLOOR) return null;
	return best;
}
