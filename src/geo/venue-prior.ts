/**
 * Venue-plausibility scoring for place naming (task #246).
 *
 * The old picker ranked `LANDMARK_PRIORITY[type] − distance/40m` — no notion
 * of whether a venue is open, whether anyone ever sits at that kind of venue
 * for 74 minutes, or whether *this user* ever visits that kind of venue at
 * all. The motivating failure: a meal-length 19:00 sit named after the
 * closed pharmacy 18 m from the smeared indoor-GPS centroid instead of the
 * open restaurant at 32 m.
 *
 * This module ranks candidates by summed log-evidence (nats), mirroring the
 * mode factor scorer:
 *
 *   distance   — Gaussian in metres (physical evidence; decisive at large
 *                gaps, gentle in the near field where GPS noise lives)
 *   venue      — a fixed offset for real venue types (amenity/tourism/shop)
 *                over areas (parks, squares, ways), worth ~1.5 nats: a venue
 *                beats an area at comparable distance but not across a large
 *                distance gap
 *   shape      — MINED visit-shape prior: log P(subtype) +
 *                log P(dwell bucket | subtype) + log P(hour | subtype),
 *                each relative to uniform, from the user's own stay history
 *                (`venue_type_priors`), with subtype → category → uniform
 *                backoff. No hand-tuned venue numbers — empty priors score
 *                exactly 0 everywhere.
 *   hours      — opening-hours evidence from the venue's OSM tag: open
 *                during the stay is weak support, closed is strong (but
 *                out-votable — OSM hours go stale; never a veto). A missing
 *                or unparseable tag is NO evidence.
 *
 * The one binary rule (`NEVER_DESTINATION_SUBTYPES`) is held to true
 * invariants: premises-less street furniture nobody can be "at" for a
 * 10-minute-plus stay. Anything with premises — however unlikely — is
 * weighted, not filtered.
 */

import { openFractionDuring, parseOpeningHours } from "./opening-hours.js";
import type { NearbyLandmark } from "./osm.js";

// --- venue categories (structural backoff pools, not tuned numbers) -------

/** Dwell-shape pools for the mined prior's backoff: subtypes in a pool tend
 *  to host similar visits. The mapping is structural (which pool), never
 *  quantitative (how likely) — all numbers come from mined history. */
export type VenueCategory = "food" | "lodging" | "leisure" | "errand" | "institution" | "transport" | "other";

/** Explicit subtype → category map. Enumerated rather than pattern-matched
 *  on purpose; unknown subtypes fall through to "other". */
const VENUE_CATEGORY: Record<string, VenueCategory> = {
	// food & drink — meal/drink-length sits, meal-time peaks
	restaurant: "food",
	cafe: "food",
	fast_food: "food",
	bar: "food",
	pub: "food",
	biergarten: "food",
	food_court: "food",
	ice_cream: "food",
	nightclub: "food",
	bakery: "food",
	// lodging — overnight
	hotel: "lodging",
	guest_house: "lodging",
	hostel: "lodging",
	apartment: "lodging",
	motel: "lodging",
	// leisure — hour-plus discretionary visits
	cinema: "leisure",
	theatre: "leisure",
	arts_centre: "leisure",
	museum: "leisure",
	gallery: "leisure",
	library: "leisure",
	fitness_centre: "leisure",
	sports_centre: "leisure",
	swimming_pool: "leisure",
	park: "leisure",
	playground: "leisure",
	attraction: "leisure",
	zoo: "leisure",
	casino: "leisure",
	// errands — short daytime visits, opening-hours bound
	pharmacy: "errand",
	supermarket: "errand",
	convenience: "errand",
	clothes: "errand",
	shoes: "errand",
	hairdresser: "errand",
	beauty: "errand",
	bank: "errand",
	post_office: "errand",
	dry_cleaning: "errand",
	laundry: "errand",
	optician: "errand",
	jewelry: "errand",
	books: "errand",
	gift: "errand",
	florist: "errand",
	furniture: "errand",
	mobile_phone: "errand",
	electronics: "errand",
	bicycle: "errand",
	car_repair: "errand",
	butcher: "errand",
	greengrocer: "errand",
	chemist: "errand",
	department_store: "errand",
	mall: "errand",
	kiosk: "errand",
	travel_agency: "errand",
	estate_agent: "errand",
	fuel: "errand",
	// institutions & appointments — variable daytime dwells
	hospital: "institution",
	clinic: "institution",
	doctors: "institution",
	dentist: "institution",
	veterinary: "institution",
	school: "institution",
	college: "institution",
	university: "institution",
	kindergarten: "institution",
	townhall: "institution",
	courthouse: "institution",
	police: "institution",
	place_of_worship: "institution",
	community_centre: "institution",
	social_facility: "institution",
	coworking_space: "institution",
	// transport premises
	station: "transport",
	bus_station: "transport",
	ferry_terminal: "transport",
	airport: "transport",
	parking: "transport",
	car_rental: "transport",
	charging_station: "transport",
	taxi: "transport",
};

export function categoryOfSubtype(subtype: string): VenueCategory {
	return VENUE_CATEGORY[subtype] ?? "other";
}

/** Premises-less street furniture — objects nobody can be "at" for a
 *  10-minute-plus stay. The ONLY binary rule in this module; everything
 *  with premises (a car park, an EV charging station) is weighted via the
 *  mined prior instead. Tourism POI markers (artwork, viewpoint, ...) are
 *  already filtered upstream by `filterLandmarks`. */
export const NEVER_DESTINATION_SUBTYPES: ReadonlySet<string> = new Set([
	"post_box",
	"vending_machine",
	"atm",
	"telephone",
	"waste_basket",
	"waste_disposal",
	"recycling",
	"bench",
	"shelter",
	"drinking_water",
	"fountain",
	"bicycle_parking",
	"bicycle_rental",
	"parcel_locker",
	"car_sharing",
	"motorcycle_parking",
	"grit_bin",
	"post_depot_box",
	"hydrant",
	"surveillance",
]);

// --- mined priors shape -----------------------------------------------------

/** Boundaries (minutes) between dwell buckets: errand <10, short 10–40,
 *  meal/appointment 40–150, long 150+. Buckets pool visits of a similar
 *  shape; the per-bucket masses are mined, never authored. */
export const DWELL_BUCKET_BOUNDS_MIN = [10, 40, 150] as const;
export const DWELL_BUCKETS = DWELL_BUCKET_BOUNDS_MIN.length + 1;

export function dwellBucket(durationSec: number): number {
	const min = durationSec / 60;
	for (let i = 0; i < DWELL_BUCKET_BOUNDS_MIN.length; i++) {
		if (min < DWELL_BUCKET_BOUNDS_MIN[i]) return i;
	}
	return DWELL_BUCKET_BOUNDS_MIN.length;
}

/** Per-venue-type visit statistics mined from the user's stay history. */
export interface VenueTypeStats {
	/** Total attributed visits of this type. */
	visits: number;
	/** Visit mass per dwell bucket (sums to `visits`). */
	dwell: number[];
	/** Visit mass per local hour of the stay midpoint (24 entries, sums to
	 *  `visits`). */
	hours: number[];
}

export interface VenuePriors {
	bySubtype: Record<string, VenueTypeStats>;
	byCategory: Partial<Record<VenueCategory, VenueTypeStats>>;
	totalVisits: number;
}

// --- scoring ---------------------------------------------------------------

/** Distance Gaussian width. GPS centroids of clean stays sit within tens of
 *  metres of the venue; 40 m keeps near-field differences gentle (18 m vs
 *  32 m ≈ 0.2 nats) while a 100 m+ gap is decisive (−3 nats at 100 m). When
 *  #244 lands, poor-GPS stays will pass a doorstep-anchored point instead of
 *  the smeared centroid — same σ, better coordinates. */
const DISTANCE_SIGMA_M = 40;

/** A real venue (amenity/tourism/shop) beats an area label (park, square,
 *  way) at comparable distance — but not across a big distance gap. Bounded
 *  by the pinned pickBestLandmark behaviors: must exceed ~1.1 nats (café
 *  30 m vs park 10 m) and stay under ~2.8 nats (café 95 m vs park 5 m). */
const VENUE_OVER_AREA_NATS = 1.5;

/** Opening-hours evidence: fully open = mild support (+0.7 — many venues
 *  are open, it proves little), fully closed = strong but out-votable
 *  counter-evidence (−2.5 — OSM hours go stale; never a veto). */
const HOURS_OPEN_NATS = 0.7;
const HOURS_CLOSED_NATS = -2.5;

/** Smoothing pseudo-counts for the mined prior: how many uniform pseudo
 *  visits a subtype must out-weigh before its mined shape dominates, and
 *  the cap on how much the category pool can contribute. */
const DWELL_PSEUDO_VISITS = 4;
const HOUR_PSEUDO_VISITS = 8;
const CATEGORY_VISIT_CAP = 12;
const BASE_RATE_PSEUDO = 0.5;
/** Assumed minimum size of the subtype universe for the base-rate term, so
 *  sparse early histories don't produce wild log-ratios. */
const BASE_RATE_MIN_TYPES = 8;

/** Clamps per component — the same discipline as the mode factors: no
 *  single piece of evidence may dominate unboundedly. */
const SHAPE_CLAMP = { dwell: [-2, 1.2], hour: [-1.5, 1.2], base: [-2, 1.5] } as const;

/** Near-field distance dominance: a real point venue (amenity/tourism/shop)
 *  within this many metres of the stay centroid is one you are *sitting on* —
 *  it wins outright over any farther candidate, regardless of mined shape or
 *  opening-hours. Physical proximity at this scale is stronger evidence than
 *  any prior: you cannot be "at" a café 28 m away when a clinic is 8 m away.
 *  12 m is the urban doorstep scale — tight enough that a genuinely ambiguous
 *  mid-field sit (the closed-venue-15 m-away hours case) still falls through
 *  to the scored ranking. Enclosing institutions still outrank this. */
const NEAR_FIELD_DECISIVE_M = 12;

const clamp = (x: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, x));

/** Shrunk estimate of P(bin | subtype): subtype mass, backed off through a
 *  capped category pool, then a uniform pseudo-count. With no data at all
 *  this is exactly uniform → a log-ratio of 0 (no evidence). */
function blendedBinP(
	st: VenueTypeStats | undefined,
	cat: VenueTypeStats | undefined,
	pick: (s: VenueTypeStats) => number,
	dims: number,
	pseudo: number,
): number {
	const u = 1 / dims;
	const stN = st?.visits ?? 0;
	const catN = Math.min(cat?.visits ?? 0, CATEGORY_VISIT_CAP);
	const stMass = st && stN > 0 ? pick(st) : 0;
	const catMass = cat && (cat.visits ?? 0) > 0 ? (pick(cat) / cat.visits) * catN : 0;
	return (stMass + catMass + pseudo * u) / (stN + catN + pseudo);
}

export interface StayShape {
	startUnix: number;
	endUnix: number;
	/** IANA timezone the stay happened in (venue-local). */
	tz: string;
}

export interface VenueScoreParts {
	distance: number;
	venue: number;
	/** Mined visit-shape prior (base rate + dwell + hour); null when priors
	 *  or stay context are absent, or the landmark is not a typed venue. */
	shape: number | null;
	/** Opening-hours evidence; null when the tag is absent/unparseable or
	 *  there is no stay context. */
	hours: number | null;
}

export interface VenueCandidateScore {
	landmark: NearbyLandmark;
	total: number;
	parts: VenueScoreParts;
	/** This candidate qualified for near-field distance dominance — it is
	 *  ranked above every non-near-field candidate REGARDLESS of `total`. The
	 *  flag is what makes the short-circuit measurable: when the top candidate
	 *  carries it, the summed evidence below did not decide this stay. */
	nearField: boolean;
}

// --- mining ------------------------------------------------------------------

/** Attribution gates for the prior miner: a stay trains the prior only when
 *  ONE venue is geometrically unambiguous — close enough to be "at"
 *  (≤30 m, the urban building-footprint scale) and clear of the runner-up
 *  by a margin GPS noise can't flip (20 m). Everything else is exactly the
 *  ambiguity the scorer must PREDICT; training on the old picker's guesses
 *  there would launder its mistakes into the prior (the same feedback-loop
 *  trap as the biometric "phantom cycling" mining). */
const ATTRIBUTION_MAX_DIST_M = 30;
const ATTRIBUTION_MARGIN_M = 20;

/** The venue (amenity/tourism/shop, not street furniture) this stay is
 *  unambiguously at, or null when no venue passes the gates. */
export function attributeStayVenue(landmarks: readonly NearbyLandmark[]): NearbyLandmark | null {
	const venues = landmarks
		.filter((l) => VENUE_TYPES.has(l.type) && !NEVER_DESTINATION_SUBTYPES.has(l.subtype))
		.sort((a, b) => a.distanceM - b.distanceM);
	const top = venues[0];
	if (!top || top.distanceM > ATTRIBUTION_MAX_DIST_M) return null;
	const next = venues.find((l) => l.name !== top.name);
	if (next && next.distanceM < top.distanceM + ATTRIBUTION_MARGIN_M) return null;
	return top;
}

/** One attributed training stay: which venue type, how long, when. */
export interface AttributedStay {
	subtype: string;
	durationSec: number;
	/** Local hour (0–23, venue tz) of the stay midpoint. */
	localHour: number;
}

/** Aggregate attributed stays into the priors blob. Pure counting — every
 *  number in the result is mined, none authored. */
export function minePriors(stays: readonly AttributedStay[]): VenuePriors {
	const bySubtype: Record<string, VenueTypeStats> = {};
	const byCategory: Partial<Record<VenueCategory, VenueTypeStats>> = {};
	const emptyStats = (): VenueTypeStats => ({
		visits: 0,
		dwell: new Array(DWELL_BUCKETS).fill(0),
		hours: new Array(24).fill(0),
	});
	for (const stay of stays) {
		const bucket = dwellBucket(stay.durationSec);
		const hour = ((stay.localHour % 24) + 24) % 24;
		let st = bySubtype[stay.subtype];
		if (!st) {
			st = emptyStats();
			bySubtype[stay.subtype] = st;
		}
		st.visits++;
		st.dwell[bucket]++;
		st.hours[hour]++;
		const category = categoryOfSubtype(stay.subtype);
		let cat = byCategory[category];
		if (!cat) {
			cat = emptyStats();
			byCategory[category] = cat;
		}
		cat.visits++;
		cat.dwell[bucket]++;
		cat.hours[hour]++;
	}
	return { bySubtype, byCategory, totalVisits: stays.length };
}

/** Honest-label floor for the stay-context path in `bestPlace`: when even
 *  the best candidate scores below this, no venue (or area) nearby is a
 *  plausible destination and the resolver falls through to the
 *  residential-address / zoom-16 area chain. Calibration: a lone venue at
 *  the 100 m radius edge (−3.1 distance + 1.5 venue) or a venue at ~50 m
 *  that is closed during the stay sits below; an open venue within ~75 m
 *  stays above. */
export const VENUE_RANK_FLOOR_NATS = -1.5;

const VENUE_TYPES: ReadonlySet<NearbyLandmark["type"]> = new Set(["amenity", "tourism", "shop"]);
/** Types whose subtype participates in the mined prior. `place`/`highway`
 *  subtypes (square, pedestrian) name areas, not visitable venues. */
const PRIOR_TYPES: ReadonlySet<NearbyLandmark["type"]> = new Set(["amenity", "tourism", "shop", "leisure"]);

function shapeScore(subtype: string, stay: StayShape, priors: VenuePriors): number {
	const st = priors.bySubtype[subtype];
	const cat = priors.byCategory[categoryOfSubtype(subtype)];
	const bucket = dwellBucket(stay.endUnix - stay.startUnix);
	const dwellP = blendedBinP(st, cat, (s) => s.dwell[bucket] ?? 0, DWELL_BUCKETS, DWELL_PSEUDO_VISITS);
	const midUnix = (stay.startUnix + stay.endUnix) / 2;
	// Local hour of the stay midpoint, via the venue-open computation's own
	// tz machinery: a 1-minute probe window centred on the midpoint.
	const hour = localHourOf(midUnix, stay.tz);
	const hourP = blendedBinP(st, cat, (s) => s.hours[hour] ?? 0, 24, HOUR_PSEUDO_VISITS);
	const kTypes = Math.max(Object.keys(priors.bySubtype).length, BASE_RATE_MIN_TYPES);
	const baseP = ((st?.visits ?? 0) + BASE_RATE_PSEUDO) / (priors.totalVisits + BASE_RATE_PSEUDO * kTypes);
	return (
		clamp(Math.log(baseP * kTypes), SHAPE_CLAMP.base) +
		clamp(Math.log(dwellP * DWELL_BUCKETS), SHAPE_CLAMP.dwell) +
		clamp(Math.log(hourP * 24), SHAPE_CLAMP.hour)
	);
}

// Small local-hour helper (mirrors opening-hours.ts's formatter cache but
// only needs the hour). Exported for the prior miner, which must bucket
// training stays by the same hour definition the scorer reads back.
const hourFormatterCache = new Map<string, Intl.DateTimeFormat>();
export function localHourOf(tsUnix: number, tz: string): number {
	let f = hourFormatterCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false });
		hourFormatterCache.set(tz, f);
	}
	const h = Number(f.formatToParts(new Date(tsUnix * 1000)).find((p) => p.type === "hour")?.value ?? 0);
	return h === 24 ? 0 : h;
}

function hoursScore(landmark: NearbyLandmark, stay: StayShape): number | null {
	if (!landmark.openingHours) return null;
	const spec = parseOpeningHours(landmark.openingHours);
	if (spec === null) return null; // outside the parser subset — no evidence
	const frac = openFractionDuring(spec, stay.startUnix, stay.endUnix, stay.tz);
	return HOURS_CLOSED_NATS + frac * (HOURS_OPEN_NATS - HOURS_CLOSED_NATS);
}

/**
 * Rank landmark candidates for a stay by summed log-evidence, best first.
 * `stay` and `priors` are optional — without them the ranking degrades to
 * distance + venue-over-area (the context-free behavior `pickBestLandmark`
 * exposes). Enclosing institutions outrank everything (unchanged semantics).
 */
export function rankVenues(
	landmarks: readonly NearbyLandmark[],
	stay: StayShape | null,
	priors: VenuePriors | null,
): VenueCandidateScore[] {
	const eligible = landmarks.filter((l) => !NEVER_DESTINATION_SUBTYPES.has(l.subtype));
	// Degenerate input (everything is street furniture): better to rank the
	// furniture than to return nothing — callers rely on non-empty in.
	const pool = eligible.length > 0 ? eligible : landmarks;
	// A real point venue within NEAR_FIELD_DECISIVE_M is one you are sitting
	// on — it outranks any farther candidate (and the prior) but not an
	// enclosing institution. EXCEPT a venue OSM says is closed during the
	// stay: then either OSM is stale or you are at a different (perhaps
	// unmapped) place — proximity is no longer decisive, so fall back to the
	// scored ranking where the closed penalty can be weighed. Open or
	// hours-unknown venues remain eligible.
	const isNearField = (l: NearbyLandmark): boolean => {
		if (l.reverseGeocoded || !VENUE_TYPES.has(l.type) || l.distanceM > NEAR_FIELD_DECISIVE_M) return false;
		const h = stay ? hoursScore(l, stay) : null;
		return h === null || h >= 0;
	};
	const scored = pool.map((landmark): VenueCandidateScore => {
		const distance = -0.5 * (landmark.distanceM / DISTANCE_SIGMA_M) ** 2;
		const venue = VENUE_TYPES.has(landmark.type) ? VENUE_OVER_AREA_NATS : 0;
		const shape = stay && priors && PRIOR_TYPES.has(landmark.type) ? shapeScore(landmark.subtype, stay, priors) : null;
		const hours = stay ? hoursScore(landmark, stay) : null;
		return {
			landmark,
			total: distance + venue + (shape ?? 0) + (hours ?? 0),
			parts: { distance, venue, shape, hours },
			nearField: isNearField(landmark),
		};
	});
	return scored.sort((a, b) => {
		const ea = a.landmark.enclosing === true;
		const eb = b.landmark.enclosing === true;
		if (ea !== eb) return ea ? -1 : 1;
		const na = a.nearField;
		const nb = b.nearField;
		if (na !== nb) return na ? -1 : 1;
		// Two near-field venues: the nearer one is what you are sitting on.
		if (na && nb && a.landmark.distanceM !== b.landmark.distanceM) return a.landmark.distanceM - b.landmark.distanceM;
		if (a.total !== b.total) return b.total - a.total;
		if (a.landmark.distanceM !== b.landmark.distanceM) return a.landmark.distanceM - b.landmark.distanceM;
		return a.landmark.name.localeCompare(b.landmark.name);
	});
}
