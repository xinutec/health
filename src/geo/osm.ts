/**
 * OpenStreetMap enrichment for transport segments.
 *
 * - Stationary segments: reverse-geocode the centroid via Nominatim to get place name/type
 * - Moving segments: query Overpass for nearby ways (highway, railway, etc.) to refine the mode
 *
 * Results cached in MariaDB (osm_cache table) keyed by rounded coordinates.
 * Cache hits avoid network entirely — page loads go from seconds to ms.
 */

import { db } from "../db/pool.js";
import { scoreCandidates } from "./factors/aggregator.js";
import { biometricLL } from "./factors/biometric-ll.js";
import { classifierPrior } from "./factors/classifier-prior.js";
import { useFactorScorer } from "./factors/feature-flag.js";
import { modeCoherence } from "./factors/mode-coherence.js";
import { modePrior } from "./factors/mode-prior.js";
import { osmDistance } from "./factors/osm-distance.js";
import { railCorridor } from "./factors/rail-corridor.js";
import { type BiometricContext, generateRefineModeCandidates } from "./factors/refine-mode-candidates.js";
import { speedEmission } from "./factors/speed-emission.js";
import type { Factor, ScoredRefinement } from "./factors/types.js";
import type { OsmAdapter } from "./osm-adapter.js";
import type { TransportMode } from "./segments.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";

import {
	type BuildingFootprint,
	ensureCovered,
	queryBuildingsNear,
	queryDrivableRoads,
	queryLines,
	queryPoints,
	queryWalkableRoads,
} from "./osm-local.js";
import { USER_AGENT } from "./osm-overpass.js";
import type { OsmRoadWay } from "./road-match.js";
import { rankVenues, type StayShape, VENUE_RANK_FLOOR_NATS, type VenuePriors } from "./venue-prior.js";
import { traceVenueDecision } from "./venue-trace.js";

/**
 * Overpass endpoints, tried in order. The main server overpass-api.de is
 * volunteer-run and intermittently overloaded; kumi.systems is a known-good
 * mirror with similar rate limits. We fall through on fetch-throw or 5xx
 * so a primary outage doesn't poison our positive cache with empty results.
 */
// Round to 4 decimals = ~11m precision for cache key
function roundCoord(n: number): number {
	return Math.round(n * 10000) / 10000;
}

async function cacheGet<T>(queryType: string, lat: number, lon: number): Promise<T | undefined> {
	const row = await db()
		.selectFrom("osm_cache")
		.select("result")
		.where("query_type", "=", queryType)
		.where("lat_rounded", "=", roundCoord(lat))
		.where("lon_rounded", "=", roundCoord(lon))
		.executeTakeFirst();
	return row ? (JSON.parse(row.result) as T) : undefined;
}

async function cacheSet(queryType: string, lat: number, lon: number, value: unknown): Promise<void> {
	const json = JSON.stringify(value);
	await db()
		.insertInto("osm_cache")
		.values({
			query_type: queryType,
			lat_rounded: roundCoord(lat),
			lon_rounded: roundCoord(lon),
			result: json,
		})
		.onDuplicateKeyUpdate({ result: json })
		.execute();
}

// --- Negative caching + in-flight dedup ---

const NEGATIVE_CACHE_TTL_MS = 5 * 60_000; // 5 min — long enough to survive a rate-limit recovery

interface NegSentinel {
	_err: number; // HTTP status that caused the failure
	_at: number; // ms epoch
}

function isNegSentinel(v: unknown): v is NegSentinel {
	return typeof v === "object" && v !== null && "_err" in v && "_at" in v;
}

const inflight = new Map<string, Promise<unknown>>();

type FetcherResult<T> = { ok: true; value: T } | { ok: false; status: number };

/**
 * Common cache wrapper for OSM lookups. Handles three concerns at once:
 *
 *  - **Positive cache**: a previously-fetched valid response is returned
 *    immediately (including null / empty-array as valid "no result here").
 *  - **Negative cache (TTL)**: a 4xx/5xx fetcher result is recorded as a
 *    sentinel `{ _err, _at }`. Subsequent calls within `NEGATIVE_CACHE_TTL_MS`
 *    return `defaultEmpty` without re-fetching — protects against
 *    thundering-herd on Overpass / Nominatim outages.
 *  - **In-flight dedup**: if the same key is already being fetched, the
 *    second caller awaits the same promise instead of firing a duplicate
 *    request.
 */
async function withCache<T>(
	queryType: string,
	lat: number,
	lon: number,
	fetcher: () => Promise<FetcherResult<T>>,
	defaultEmpty: T,
): Promise<T> {
	const cached = await cacheGet<T | NegSentinel>(queryType, lat, lon);
	if (cached !== undefined) {
		if (isNegSentinel(cached)) {
			if (Date.now() - cached._at < NEGATIVE_CACHE_TTL_MS) return defaultEmpty;
			// expired — fall through to refetch
		} else {
			return cached as T;
		}
	}

	const inflightKey = `${queryType}|${roundCoord(lat)}|${roundCoord(lon)}`;
	const existing = inflight.get(inflightKey);
	if (existing) return existing as Promise<T>;

	const promise = (async () => {
		try {
			let result: FetcherResult<T>;
			try {
				result = await fetcher();
			} catch (e) {
				// Network-level failure (DNS, TLS, refused connection, etc.) —
				// fetch() throws before any HTTP status. Treat as a transient
				// failure so subsequent calls within the TTL are short-circuited;
				// without this we'd thunder on every dashboard reload.
				console.warn(`OSM fetch threw for ${queryType} ${lat},${lon}: ${e}`);
				result = { ok: false, status: 0 };
			}
			if (result.ok) {
				await cacheSet(queryType, lat, lon, result.value);
				return result.value;
			}
			await cacheSet(queryType, lat, lon, { _err: result.status, _at: Date.now() } satisfies NegSentinel);
			return defaultEmpty;
		} finally {
			inflight.delete(inflightKey);
		}
	})();
	inflight.set(inflightKey, promise);
	return promise;
}

// --- Nominatim reverse geocoding ---

export interface NominatimResult {
	displayName: string;
	type: string; // e.g. "restaurant", "cafe", "park", "residential", "square"
	category: string; // top-level category, e.g. "amenity", "leisure", "building", "place"
	address: {
		amenity?: string;
		tourism?: string; // "hotel", "museum", etc.
		leisure?: string; // "park", "playground", etc.
		shop?: string; // "supermarket", "bakery", etc.
		building?: string;
		house_number?: string;
		road?: string;
		pedestrian?: string; // square / pedestrian street name
		neighbourhood?: string;
		suburb?: string;
		// City-like fields. Nominatim picks one of these based on the place's
		// administrative classification + population, so we have to check all.
		city?: string;
		town?: string;
		village?: string;
		municipality?: string;
		// One level up from city — used to collapse administrative
		// subdivisions of large metropolitan areas. For London boroughs
		// Nominatim returns city="City of Westminster" (or other borough)
		// and state_district="Greater London"; without this the timeline
		// would split a single London day across multiple sub-borough
		// headers. See METROPOLITAN_AREAS.
		state_district?: string;
		state?: string;
		country?: string;
		postcode?: string;
	};
}

/**
 * State-district / region values that should override the more specific
 * `city` field when picking a display name. Each entry is a metro area
 * whose administrative subdivisions are not useful as timeline headers
 * (e.g. London's 33 boroughs all live inside Greater London — the user
 * thinks of them as "London"). Extend conservatively: each addition
 * collapses fine-grained data into coarser groups.
 */
const METROPOLITAN_AREAS = new Set([
	"Greater London",
	"Greater Manchester",
	// Île-de-France: Paris + suburbs. Nominatim returns this for the
	// arrondissements.
	"Île-de-France",
]);

/**
 * Cities that are administrative subdivisions of a metropolitan area and
 * should be displayed as the metro instead. London has 33 boroughs; 31 of
 * them return city="Greater London" from Nominatim directly. The two that
 * don't — Westminster and the City of London — are historic "cities" in
 * their own right and need this explicit mapping. Extend conservatively
 * as similar cases turn up (Île-de-France's arrondissements all return
 * city="Paris" so they don't need entries here).
 */
const SUBDIVISION_TO_METRO = new Map<string, string>([
	["City of Westminster", "Greater London"],
	["City of London", "Greater London"],
]);

/**
 * Pick the best "city" name from a Nominatim result. Nominatim returns one of
 * `city`, `town`, `village`, `municipality` depending on a place's admin
 * level + population, so we walk them in preference order. Returns null when
 * the result is null or none of those fields are present.
 *
 * Used to attach a `city` to stationary segments so the timeline UI can group
 * consecutive same-city segments under one heading.
 */
export function extractCity(result: NominatimResult | null): string | null {
	if (!result) return null;
	const a = result.address;
	// If the response carries a recognised metropolitan area, use that
	// instead of the city — keeps a single London day under one header
	// instead of splitting into "City of Westminster" / "Greater London".
	if (a.state_district !== undefined && METROPOLITAN_AREAS.has(a.state_district)) {
		return a.state_district;
	}
	const raw = a.city ?? a.town ?? a.village ?? a.municipality ?? null;
	if (raw !== null) {
		const collapsed = SUBDIVISION_TO_METRO.get(raw);
		if (collapsed !== undefined) return collapsed;
	}
	return raw;
}

/**
 * Return the shared city of two reverse-geocoded points, or null. Used to
 * tag moving segments only when both endpoints agree — a 5-min walk that
 * stays inside one city earns a city header in the timeline; a long drive
 * between two cities (or a walk crossing a boundary) gets no tag and reads
 * as a transit between groups.
 */
export function commonCity(a: NominatimResult | null, b: NominatimResult | null): string | null {
	const ca = extractCity(a);
	const cb = extractCity(b);
	return ca !== null && ca === cb ? ca : null;
}

interface NominatimResponse {
	display_name?: string;
	type?: string;
	category?: string;
	class?: string;
	address?: NominatimResult["address"];
}

export async function reverseGeocode(lat: number, lon: number, zoom = 18): Promise<NominatimResult | null> {
	return withCache<NominatimResult | null>(
		`nominatim_z${zoom}`,
		lat,
		lon,
		async () => {
			const url = new URL(NOMINATIM_URL);
			url.searchParams.set("lat", lat.toString());
			url.searchParams.set("lon", lon.toString());
			url.searchParams.set("format", "json");
			url.searchParams.set("zoom", zoom.toString());

			const res = await fetch(url.toString(), { headers: { "User-Agent": USER_AGENT } });
			if (!res.ok) {
				console.warn(`Nominatim returned ${res.status} for ${lat},${lon}`);
				return { ok: false, status: res.status };
			}

			const data = (await res.json()) as NominatimResponse;
			if (!data.display_name) return { ok: true, value: null };

			return {
				ok: true,
				value: {
					displayName: data.display_name,
					type: data.type ?? "",
					category: data.class ?? data.category ?? "",
					address: data.address ?? {},
				},
			};
		},
		null,
	);
}

/**
 * Look up a stationary place. Strategy, in order:
 *
 * 0. If the centroid sits inside a large institution's mapped footprint
 *    (hospital, university, …), name the stay after that institution.
 *    A long dwell inside a hospital is the hospital — not a cafe that
 *    Nominatim or a nearer POI node would otherwise name, since those
 *    point venues often share the institution's site.
 * 1. Detailed building-level Nominatim (zoom 18) — catches venues with
 *    addresses (Brasserie Vermeer, Hotel X). Used directly if it
 *    returns a specific venue.
 * 2. Otherwise the best nearby Overpass landmark within 100 m. The GPS
 *    centroid often lands on a residential building next door to a
 *    square/park/venue; this surfaces the landmark instead.
 * 3. Area-level Nominatim (zoom 16) as a softer fallback for places
 *    where the landmark is only known to Nominatim.
 * 4. Last resort: return the residential address from step 1.
 */
export interface BestPlaceOptions {
	/** Prefer residential address over a nearby amenity. Use when the segment
	 *  contains overnight hours (the user is sleeping in a building, not at
	 *  the cafe next door). */
	preferResidential?: boolean;
	/** Stay window in the venue-local timezone. When present, the landmark
	 *  step switches to the full venue-plausibility ranking (#246): opening
	 *  hours + mined visit-shape priors weigh in, a Nominatim point-venue is
	 *  folded into the candidate set instead of bypassing the ranking, and
	 *  an implausible best venue falls through to the honest area label.
	 *  Absent → the context-free behavior, unchanged. */
	stay?: StayShape;
	/** Mined visit-shape priors (`venue_type_priors`); only consulted when
	 *  `stay` is present. Null/absent contributes no shape evidence. */
	priors?: VenuePriors | null;
}

/** Carry a Nominatim result's address (city, road) onto a landmark
 *  result so the timeline can still group consecutive stays by city. */
function withAddressFrom(result: NominatimResult, detailed: NominatimResult | null): NominatimResult {
	if (detailed) result.address = { ...detailed.address, ...result.address };
	return result;
}

/** The venue name a specific-venue Nominatim result carries (the address
 *  fields hold the name, not the tag value). */
function nominatimVenueName(r: NominatimResult): string | null {
	return r.address.amenity ?? r.address.tourism ?? r.address.shop ?? r.address.leisure ?? null;
}

/** Map a specific-venue Nominatim result onto a landmark candidate so the
 *  venue-plausibility ranking can weigh it against the Overpass landmarks.
 *  Distance 0: Nominatim zoom-18 names the building the centroid is on. */
function nominatimVenueCandidate(r: NominatimResult): NearbyLandmark | null {
	const name = nominatimVenueName(r);
	if (!name) return null;
	const type =
		r.category === "tourism" || r.category === "shop" || r.category === "leisure" ? r.category : ("amenity" as const);
	return { name, type, subtype: r.type, distanceM: 0, reverseGeocoded: true };
}

export async function bestPlace(
	osm: OsmAdapter,
	lat: number,
	lon: number,
	opts: BestPlaceOptions = {},
): Promise<NominatimResult | null> {
	// Fetch nearby landmarks up front. A stay whose centroid sits inside
	// a large institution's mapped footprint is a stay *in* that
	// institution, and that outranks even a Nominatim point-venue at the
	// same coordinate — Nominatim happily names a stay after a cafe that
	// shares the institution's site.
	const landmarks = await osm.nearbyLandmarks(lat, lon, 100);
	const detailed = await osm.reverseGeocode(lat, lon, 18);

	let bestLandmark: NearbyLandmark | null = null;
	let nominatimWon = false;
	if (opts.stay) {
		// Venue-plausibility path (#246): rank ALL candidates — Overpass
		// landmarks plus a specific-venue Nominatim result — by summed
		// evidence (distance, opening hours, mined visit-shape priors).
		const candidates = [...landmarks];
		const nomVenue = detailed && hasSpecificVenue(detailed) ? nominatimVenueCandidate(detailed) : null;
		// Skip the Nominatim candidate when a landmark already names the
		// same venue — the landmark carries the opening_hours tag.
		if (nomVenue && !landmarks.some((l) => l.name === nomVenue.name)) candidates.push(nomVenue);
		if (candidates.length > 0) {
			const ranked = rankVenues(candidates, opts.stay, opts.priors ?? null);
			const top = ranked[0];
			const accepted = top.landmark.enclosing === true || top.total >= VENUE_RANK_FLOOR_NATS;
			if (process.env.VENUE_DEBUG === "1") {
				console.error(
					`[venue] ${lat.toFixed(5)},${lon.toFixed(5)} stay=${new Date(opts.stay.startUnix * 1000).toISOString().slice(11, 16)}-${new Date(opts.stay.endUnix * 1000).toISOString().slice(11, 16)} priors=${opts.priors ? "y" : "n"} top=${top.landmark.name} total=${top.total.toFixed(2)} candidates=${candidates.length}`,
				);
			}
			traceVenueDecision({ lat, lon, stay: opts.stay, ranked, accepted });
			if (accepted) {
				if (nomVenue && top.landmark.name === nomVenue.name) nominatimWon = true;
				else bestLandmark = top.landmark;
			}
			// Below the floor: no candidate is a plausible destination —
			// fall through to the residential / area chain (honest label).
		}
	} else {
		bestLandmark = landmarks.length > 0 ? pickBestLandmark(landmarks) : null;
	}

	if (bestLandmark?.enclosing) {
		return withAddressFrom(landmarkToResult(bestLandmark), detailed);
	}

	if (detailed && hasSpecificVenue(detailed) && (opts.stay ? nominatimWon : true)) return detailed;

	// Sleep-window override: a lodging POI (hotel, guest_house, hostel,
	// motel, apartment) within ~50 m of the centroid wins over the
	// residential-address preference. A stay overlapping a sleep window
	// 5 m from a guesthouse is sleep at the guesthouse, not at the
	// neighbouring residential building Nominatim happened to name.
	// Without this, the address fallback below stamps the wrong label
	// on every hotel / guesthouse stay.
	if (opts.preferResidential) {
		const lodging = pickLodgingOverride(landmarks);
		if (lodging) return withAddressFrom(landmarkToResult(lodging), detailed);
	}

	// Overnight stays: trust the residential address from zoom 18 over any
	// nearby amenity. The user is in the building, not at the closest cafe.
	if (opts.preferResidential && detailed && hasResidentialAddress(detailed)) {
		return detailed;
	}

	if (bestLandmark) {
		return withAddressFrom(landmarkToResult(bestLandmark), detailed);
	}

	// No specific venue and no nearby landmark — fall back to the address if we have one
	if (detailed && hasResidentialAddress(detailed)) return detailed;

	const area = await osm.reverseGeocode(lat, lon, 16);
	if (area && (hasSpecificVenue(area) || isLandmark(area))) return area;
	return detailed ?? area;
}

function hasSpecificVenue(r: NominatimResult): boolean {
	const a = r.address;
	return !!(a.amenity || a.tourism || a.leisure || a.shop);
}

function hasResidentialAddress(r: NominatimResult): boolean {
	return !!(r.address.house_number && r.address.road);
}

function isLandmark(r: NominatimResult): boolean {
	// Squares, parks, plazas, named pedestrian areas — useful even without a venue
	return r.category === "place" || r.category === "leisure" || !!r.address.pedestrian;
}

// --- Overpass: nearby named landmarks ---

/**
 * tourism subtypes that are POI markers, not venues. Skipped from
 * nearbyLandmarks so a roadside artwork or viewpoint doesn't beat a real
 * café next door for the "what is the user actually at" label.
 */
const POI_MARKER_TOURISM = new Set(["artwork", "viewpoint", "picnic_site", "information"]);

/** tourism subtypes that denote indoor lodging — a stay overlapping a
 *  sleep window within a short radius of one of these means the user
 *  slept *at* the lodging, regardless of which residential building the
 *  GPS centroid lands on. The set is intentionally narrow: only indoor
 *  accommodation, not caravan_site / camp_site / chalet variants that
 *  could legitimately be a stop without being where the user slept.
 *  Use via `isLodgingLandmark` + `pickLodgingOverride`. */
export const LODGING_TOURISM_SUBTYPES = new Set(["hotel", "guest_house", "hostel", "apartment", "motel"]);

/** Maximum distance under which a lodging POI is the place the user
 *  slept, rather than something they slept next door to. 50 m matches
 *  `VENUE_VOTE_MAX_DIST_M` — a typical urban building footprint. */
const LODGING_OVERRIDE_DIST_M = 50;

/** True when the landmark is an indoor lodging POI — see
 *  {@link LODGING_TOURISM_SUBTYPES}. */
export function isLodgingLandmark(landmark: NearbyLandmark): boolean {
	return landmark.type === "tourism" && LODGING_TOURISM_SUBTYPES.has(landmark.subtype);
}

/** Pick the closest nearby lodging POI within `LODGING_OVERRIDE_DIST_M`
 *  metres, or null if none qualify. Used by `bestPlace` to override the
 *  residential-address preference for sleep windows: when the user
 *  slept 5 m from a guesthouse, the guesthouse is the right label even
 *  when the residential address would otherwise win. */
export function pickLodgingOverride(landmarks: readonly NearbyLandmark[]): NearbyLandmark | null {
	const lodging = landmarks.filter((l) => isLodgingLandmark(l) && l.distanceM <= LODGING_OVERRIDE_DIST_M);
	if (lodging.length === 0) return null;
	return [...lodging].sort((a, b) => a.distanceM - b.distanceM)[0];
}

export interface NearbyLandmark {
	name: string;
	type: "amenity" | "tourism" | "leisure" | "shop" | "place" | "highway";
	subtype: string; // "restaurant", "park", "square", "pedestrian", etc.
	distanceM: number;
	/** Raw OSM `opening_hours` tag when present — the venue-plausibility
	 *  scorer turns it into open/closed evidence for a stay window. Optional:
	 *  ~70% of venue POIs lack the tag, and golden fixtures recorded before
	 *  this field existed simply omit it (= no evidence). */
	openingHours?: string;
	/** True when this landmark is a large institution whose mapped
	 *  footprint encloses the query point — see {@link LARGE_INSTITUTION_SUBTYPES}.
	 *  A stay whose centroid falls inside such a footprint is a stay
	 *  *in* the institution, not at a nearer point POI. */
	enclosing?: boolean;
	/** True for a candidate synthesised from a Nominatim reverse-geocode
	 *  rather than measured against the query point. Its `distanceM` is 0 by
	 *  construction (Nominatim placed the query *in* the building), so it must
	 *  NOT qualify for near-field distance dominance — that shortcut is for
	 *  genuinely-measured proximity (an Overpass POI a few metres away). It
	 *  still competes on score, where distance 0 already gives it a strong
	 *  lead that real evidence (e.g. closed hours) can override. */
	reverseGeocoded?: boolean;
}

/** `amenity` values that get the enclosing-institution override — where a
 *  stay inside the footprint (or, for a hospital point, within campus radius)
 *  outranks a nearer point-POI. A long dwell inside a hospital is the
 *  hospital, not the cafe next door whose node sits closer to the noisy GPS
 *  centroid.
 *
 *  **Hospitals only.** `university` / `college` were dropped 2026-06-07: OSM
 *  campus polygons have loose bounding boxes (the `encloses` test is
 *  `MBRContains`, not true containment) that swallow neighbouring venues, and
 *  a university hosts cafes / restaurants you visit *as destinations* — a
 *  Greek restaurant next to LSHTM is the restaurant (a mined focus place),
 *  not the university (2026-05-14). A hospital is the one institution where
 *  "long sedentary stay nearby = you are at it" reliably holds. No golden
 *  relies on a university/college enclosing (the enclosing days — NHNN
 *  2026-05-18, HMC 2026-04-29 — are both hospitals). */
export const LARGE_INSTITUTION_SUBTYPES = new Set(["hospital"]);

/** A large institution mapped only as a POINT (no ingested footprint — big
 *  hospitals are commonly multipolygon relations the landmark mirror doesn't
 *  assemble, so only the centroid/entrance node survives) still means "you
 *  are at the institution" when the stay centroid sits within this radius of
 *  its point. Campus-scale: a stay 60–80 m from a hospital node is on the
 *  grounds, not at the café across the street. Without this, a stay deep in a
 *  hospital campus is named after whatever tiny point-POI (a hairdresser, a
 *  pharmacy) happens to sit nearest the noisy GPS centroid — the 2026-04-29
 *  HMC Westeinde case. */
export const LARGE_INSTITUTION_POINT_RADIUS_M = 80;

/** Should this landmark be treated as the enclosing institution — outranking
 *  nearer point POIs?
 *
 *  - A large-institution amenity whose footprint geometrically contains the
 *    stay (`encloses`, any of the three subtypes): yes. Definitive.
 *  - The point-only fallback (`distanceM <= LARGE_INSTITUTION_POINT_RADIUS_M`)
 *    is restricted to a **hospital** mapped as a **point**. Rationale: a long
 *    sedentary stay by a hospital node is the hospital (HMC Westeinde,
 *    2026-04-29), but a university / college has campus eateries you visit as
 *    *destinations* — a Greek restaurant next to LSHTM is the restaurant, not
 *    the university (2026-05-14) — and a polygon feature already carries the
 *    precise `encloses` signal, so the loose radius must not widen it.
 *
 *  Pure + exported so the rule is unit-testable without a DB. */
export function isEnclosingInstitution(opts: {
	type: NearbyLandmark["type"];
	subtype: string;
	distanceM: number;
	encloses: boolean;
	/** Did this landmark come from the point table (a node) vs the line/area
	 *  table (a way)? The point-radius fallback only applies to nodes. */
	isPoint: boolean;
}): boolean {
	if (opts.type !== "amenity") return false;
	if (!LARGE_INSTITUTION_SUBTYPES.has(opts.subtype)) return false; // hospital only
	if (opts.encloses) return true;
	// Point-only campus-radius fallback (a hospital mapped as a bare node).
	return opts.isPoint && opts.distanceM <= LARGE_INSTITUTION_POINT_RADIUS_M;
}

/** Context-free entry to the venue-plausibility ranking (task #246): no
 *  stay window, no mined priors — distance + venue-over-area only, with the
 *  enclosing-institution override unchanged. Callers that know the stay
 *  window should call `rankVenues` directly for the full evidence stack. */
export function pickBestLandmark(landmarks: NearbyLandmark[]): NearbyLandmark {
	return rankVenues(landmarks, null, null)[0].landmark;
}

/** Maximum distance at which a landmark counts as "the place the user
 *  is at" for the focus_places amenity vote. Beyond this the venue is
 *  something the stay is *near*, not *at*, and must not name the place. */
const VENUE_VOTE_MAX_DIST_M = 50;

/** Landmark types that name a venue a user is genuinely "at" — a café,
 *  a shop, a museum. `leisure` (a park) and `place` / `highway` name an
 *  area or a way, not a venue, so they never carry an amenity label. */
const VENUE_VOTE_TYPES: ReadonlySet<NearbyLandmark["type"]> = new Set(["amenity", "tourism", "shop"]);

/**
 * Confidence gate for the focus_places amenity vote: a landmark may
 * name a focus_place only when it is a real venue type AND close
 * enough to be the place the stay is actually *at*. A park (leisure)
 * the stay merely sits near, or a café 80 m away, fails the gate — the
 * cluster is then left with no `amenity_label`, and the runtime
 * resolves it to a neutral area/address rather than a wrong venue.
 */
export function isLabelWorthyVenue(landmark: NearbyLandmark): boolean {
	return VENUE_VOTE_TYPES.has(landmark.type) && landmark.distanceM <= VENUE_VOTE_MAX_DIST_M;
}

export function landmarkToResult(l: NearbyLandmark): NominatimResult {
	const address: NominatimResult["address"] = {};
	if (l.type === "amenity") address.amenity = l.name;
	else if (l.type === "tourism") address.tourism = l.name;
	else if (l.type === "leisure") address.leisure = l.name;
	else if (l.type === "shop") address.shop = l.name;
	else address.pedestrian = l.name; // place, highway=pedestrian
	return {
		displayName: l.name,
		type: l.subtype,
		category: l.type,
		address,
	};
}

/** Rail-class route types in OSM. Bus, ferry, bicycle, hiking, etc. are
 *  not considered "rail" for our line-disambiguation purposes. */
const RAIL_ROUTE_TYPES = new Set(["subway", "train", "light_rail", "tram", "monorail"]);

/**
 * Extract the set of named rail-line route relations from an Overpass response.
 * Used by `linesAtPoint` after fetching route relations near a coordinate.
 * Kept as a pure function so the parsing logic is testable without mocking
 * fetch.
 *
 * Permissive input typing (`tags?: Record<string, string | undefined>`)
 * because real Overpass JSON has tags as a sparsely-populated map and
 * pickier types make test fixtures awkward without buying us safety the
 * runtime checks below don't already provide.
 */
export function extractLineNames(data: {
	elements?: ReadonlyArray<{ type?: string; tags?: Record<string, string | undefined> }>;
}): Set<string> {
	const lines = new Set<string>();
	for (const el of data.elements ?? []) {
		if (el.type !== "relation") continue;
		const tags = el.tags ?? {};
		if (tags.type !== "route") continue;
		if (!tags.route || !RAIL_ROUTE_TYPES.has(tags.route)) continue;
		const name = tags.name;
		if (!name) continue;
		lines.add(name);
	}
	return lines;
}

/**
 * Find named landmarks (squares, parks, restaurants, museums, etc.) near a
 * point. Used to label stationary stays when the centroid lands on a generic
 * residential building adjacent to the actual landmark.
 */
export async function nearbyLandmarks(lat: number, lon: number, radiusM = 100): Promise<NearbyLandmark[]> {
	// Local-mirror path: landmarks live in the "landmark" feature_type
	// bucket which spans amenity / shop / tourism / leisure. Both
	// tables are queried because OSM has venue POIs (node) and
	// building outlines (way). Distance for ways comes from
	// ST_Distance (planar, converted to metres in JS) since
	// ST_Distance_Sphere is POINT-POINT only.
	await ensureCovered(lat, lon, radiusM, "landmark");
	const [points, lines] = await Promise.all([
		queryPoints(lat, lon, radiusM, "landmark"),
		queryLines(lat, lon, radiusM, "landmark"),
	]);
	const landmarks: NearbyLandmark[] = [];
	const tagged = [...points.map((f) => ({ f, isPoint: true })), ...lines.map((f) => ({ f, isPoint: false }))];
	for (const { f, isPoint } of tagged) {
		const name = f.name;
		if (!name) continue;
		// Tag-priority order matches the original Overpass-cache version:
		// amenity > tourism > leisure > shop > place. Each tag spawns its
		// own NearbyLandmark entry so the picker can score them
		// independently; an element tagged BOTH `amenity=cafe` and
		// `tourism=attraction` (rare but happens) appears twice and the
		// picker resolves precedence via LANDMARK_PRIORITY.
		const tags = f.tags;
		for (const k of ["amenity", "tourism", "leisure", "shop", "place"] as const) {
			if (tags[k]) {
				// A large institution outranks nearer point POIs when its
				// footprint encloses the query point (polygon) or — for an
				// institution mapped only as a point — when its node sits
				// within the campus radius. See isEnclosingInstitution.
				const enclosing = isEnclosingInstitution({
					type: k,
					subtype: tags[k],
					distanceM: f.distance_m,
					encloses: f.encloses,
					isPoint,
				});
				landmarks.push({
					name,
					type: k,
					subtype: tags[k],
					distanceM: f.distance_m,
					enclosing,
					...(tags.opening_hours ? { openingHours: tags.opening_hours } : {}),
				});
			}
		}
		if (tags.highway === "pedestrian") {
			landmarks.push({ name, type: "highway", subtype: "pedestrian", distanceM: f.distance_m });
		}
	}
	landmarks.sort((a, b) => a.distanceM - b.distanceM);
	return filterLandmarks(landmarks);
}

/**
 * Drop POI markers that aren't venues someone "is at" for hours. A 19m-away
 * artwork on the same square as a residential building shouldn't beat a real
 * café next door for the timeline label.
 */
export function filterLandmarks(landmarks: NearbyLandmark[]): NearbyLandmark[] {
	return landmarks.filter((l) => !(l.type === "tourism" && POI_MARKER_TOURISM.has(l.subtype)));
}

export interface NearbyStation {
	name: string;
	/** "subway", "rail", "light_rail", "tram" — what Fitbit's API calls it. */
	subtype: string;
	distanceM: number;
}

/**
 * Find named rail / metro / tram stations near a point. Used to (a) annotate
 * the start and end of a tube ride with station names, and (b) infer that a
 * GPS-gap segment between two stations was a tube ride even when speed alone
 * is ambiguous. A subway_entrance is treated as evidence of the parent
 * station — we collapse adjacent entrances by name, picking the closest.
 */
/**
 * Pick the most station-like entry from a `nearbyStations` result list.
 *
 * The complication: OSM tags station entrances as separate nodes (often
 * labelled "A", "B", "C", etc. — one per physical entrance gate). For
 * a station node within walking distance of the user's GPS fix, the
 * entrance labels may be CLOSER than the station node itself. The picker
 * therefore deprioritises:
 *   1. entries with subtype = "subway_entrance"
 *   2. single-letter names (proxy for entrance labels when subtype info
 *      is missing or coincidentally "subway")
 *
 * Falls through to closest-by-distance for the remaining candidates, or
 * to entrance-letters as a last resort if nothing else is present.
 */
export function pickBestStation(stations: NearbyStation[]): NearbyStation | null {
	if (stations.length === 0) return null;
	const isEntranceLike = (s: NearbyStation): boolean => s.subtype === "subway_entrance" || /^[A-Z]\d?$/.test(s.name);
	const real = stations.filter((s) => !isEntranceLike(s));
	if (real.length > 0) {
		return [...real].sort((a, b) => a.distanceM - b.distanceM)[0];
	}
	return [...stations].sort((a, b) => a.distanceM - b.distanceM)[0];
}

/** A transit/road-furniture node near a coordinate — bus stops and
 *  traffic signals, the location evidence for bus-vs-car inference
 *  (task #247). `name` is the stop's posted name when OSM has one. */
export interface NearbyTransitStop {
	name: string | null;
	/** "bus_stop" | "traffic_signals" */
	subtype: string;
	distanceM: number;
}

/** Bus stops + traffic signals near a point, nearest first. Own
 *  `transit_stop` coverage bucket (see osm-local.ts) — the road-way
 *  queries never fetched these nodes, so the bucket back-fills on
 *  demand like any other feature type. */
export async function nearbyTransitStops(lat: number, lon: number, radiusM = 50): Promise<NearbyTransitStop[]> {
	await ensureCovered(lat, lon, radiusM, "transit_stop");
	const features = await queryPoints(lat, lon, radiusM, "transit_stop");
	return features
		.map((f) => ({ name: f.name, subtype: f.subtype ?? "bus_stop", distanceM: f.distance_m }))
		.sort((a, b) => a.distanceM - b.distanceM);
}

export async function nearbyStations(lat: number, lon: number, radiusM = 200): Promise<NearbyStation[]> {
	// Local-mirror path: ensure the railway-feature bucket has coverage
	// for this point, then run a POINT-only spatial query against
	// osm_points. Stations are stored separately from line features
	// (osm_lines) because MariaDB's ST_Distance_Sphere is POINT-POINT
	// only — mixing types in one table tripped the optimizer.
	await ensureCovered(lat, lon, radiusM, "railway");
	const features = await queryPoints(lat, lon, radiusM, "railway", [
		"station",
		"subway_entrance",
		"halt",
		"stop",
		"tram_stop",
	]);

	// Collapse multiple entries with the same name (entrances of one
	// station) by keeping the closest. Subtype mapping mirrors the
	// previous version exactly. Entrances get their own subtype so
	// pickBestStation can deprioritise them — entrance nodes are
	// labelled "A", "B", "C" in OSM and would otherwise beat the real
	// station node by distance for nearby fixes.
	const typed = features.map((f) => ({ ...f, derivedSubtype: deriveStationSubtype(f) }));
	return dedupeStationsByName(typed);
}

function deriveStationSubtype(f: { subtype: string | null; tags: Record<string, string> }): string {
	if (f.subtype === "subway_entrance") return "subway_entrance";
	if (f.tags.station === "subway") return "subway";
	if (f.tags.station === "light_rail") return "light_rail";
	if (f.tags.tram === "yes" || f.subtype === "tram_stop") return "tram";
	if (f.subtype === "halt") return "halt";
	return "rail";
}

/**
 * Deduplicate stations-by-name from a list of OSM railway features.
 *
 * The bug this exists to solve: a station and its entrances are
 * separate OSM points sharing the station's name. Naive dedup-by-name
 * "keep closest" picks the entrance (the entrance node is physically
 * closer to a passing pedestrian) and the deduped record carries
 * `subtype = "subway_entrance"`. Downstream `pickBestStation` then
 * filters that record OUT as entrance-like — the station disappears
 * from the result entirely, and the next-nearest station wins by
 * default. Real example: a fix at the gates of one station whose
 * entrance is 15 m away ended up labelled with a different station
 * 175 m further because the entrance dedup wiped the closer one.
 *
 * Rule: station-typed entries WIN over entrance-typed ones regardless
 * of distance. The entrance was never going to be the right label
 * for the station; we keep it only as a fallback if no station node
 * exists.
 */
export function dedupeStationsByName(
	features: Array<{ name: string | null; derivedSubtype: string; distance_m: number }>,
): NearbyStation[] {
	const stations = new Map<string, NearbyStation>();
	for (const f of features) {
		if (!f.name) continue;
		const candidate: NearbyStation = { name: f.name, subtype: f.derivedSubtype, distanceM: f.distance_m };
		const existing = stations.get(f.name);
		if (!existing) {
			stations.set(f.name, candidate);
			continue;
		}
		const existingIsEntrance = existing.subtype === "subway_entrance";
		const candidateIsEntrance = candidate.subtype === "subway_entrance";
		// Prefer station-typed records over entrance-typed ones regardless
		// of distance; otherwise prefer the closer record of the same kind.
		if (existingIsEntrance && !candidateIsEntrance) {
			stations.set(f.name, candidate);
		} else if (existingIsEntrance === candidateIsEntrance && candidate.distanceM < existing.distanceM) {
			stations.set(f.name, candidate);
		}
	}
	return [...stations.values()].sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Find rail-class route relations whose member stops include a station near
 * the given coordinate. Used to disambiguate parallel-track line confusion:
 * given a tube ride between two stations A and B, the intersection of
 * `linesAtPoint(A)` and `linesAtPoint(B)` picks the unique line serving
 * both endpoints — when one line serves A but not B, it falls out of the
 * intersection.
 *
 * Overpass query: stops/stations near the point → their containing route
 * relations → relation tags. Cached via the standard OSM cache.
 */
export async function linesAtPoint(lat: number, lon: number, radiusM = 100): Promise<Set<string>> {
	// Local-mirror path: shares the `railway` coverage box that
	// nearbyStations already populated for this area (single Overpass
	// fetch covers BOTH stations and rail lines). Query osm_lines for
	// rail-class LINESTRINGs whose geometry passes within radiusM of
	// the point, dedupe by name.
	//
	// Old behaviour: Overpass queried nearby stations -> their route
	// relations -> relation tags. The new path uses the way tags
	// directly, which carry the same `name=Jubilee Line` etc. on
	// individual track segments. Edge cases where a way has no name
	// but its relation does are not currently handled — would require
	// also mirroring route relations, which we can add if it bites.
	await ensureCovered(lat, lon, radiusM, "railway");
	const features = await queryLines(lat, lon, radiusM, "railway", [
		"rail",
		"subway",
		"light_rail",
		"tram",
		"narrow_gauge",
	]);
	const names = new Set<string>();
	for (const f of features) {
		if (f.name) names.add(f.name);
	}
	return names;
}

/**
 * Produce a short, human-readable label for a place.
 * Examples: "Restaurant R (restaurant)", "Park P", "Place A (square)"
 */
export function placeLabel(result: NominatimResult): string {
	const a = result.address;

	// Specific named venue (preferred — most useful for "your day")
	if (a.amenity) return `${a.amenity}${result.type ? ` (${result.type})` : ""}`;
	if (a.tourism) return `${a.tourism}${result.type ? ` (${result.type})` : ""}`;
	if (a.leisure) return `${a.leisure}${result.type ? ` (${result.type})` : ""}`;
	if (a.shop) return `${a.shop}${result.type ? ` (${result.type})` : ""}`;

	// Building name + type
	if (a.building && result.type) return `${a.building} (${result.type})`;

	// Residential address (or any address with a clear house number).
	// Use Dutch ordering ("Place A 161") since street + number reads
	// most naturally for European postal addresses.
	if (a.house_number && a.road) return `${a.road} ${a.house_number}`;

	// Named pedestrian area / square (zoom-16 lookups commonly land here)
	if (a.pedestrian) return `${a.pedestrian}${result.type ? ` (${result.type})` : ""}`;

	// Just the type with road/neighbourhood for context
	if (result.type && a.road) return `${result.type} on ${a.road}`;
	if (result.type && a.neighbourhood) return `${result.type} in ${a.neighbourhood}`;

	// Fall back to first part of display_name
	return result.displayName.split(",")[0] ?? "Unknown";
}

// --- Overpass API for moving segments ---

export interface NearbyWay {
	type: string; // "highway", "railway", "waterway", "aeroway"
	subtype: string; // "motorway", "rail", "subway", "river", etc.
	name?: string; // e.g. "A2", "Northern Line"
	/** Distance from the GPS sample to this way's geometry, in metres.
	 *  Populated by `nearbyWays`. When aggregated across multiple
	 *  sample points (e.g. velocity.ts:474), the *minimum* distance
	 *  seen for a given (type/subtype/name) wins, so refineMode can
	 *  tell the difference between a road we brushed past once and
	 *  a road the GPS trace was hugging the whole way. Optional for
	 *  back-compat with tests that don't care. */
	distanceM?: number;
}

/**
 * Find ways (roads, rails, waterways) near a point.
 * Used to determine if a moving segment is likely a car, train, etc.
 */
export async function nearbyWays(lat: number, lon: number, radiusM = 50): Promise<NearbyWay[]> {
	// Local-mirror path: ensure all four feature_type buckets have
	// coverage for this point, then run a spatial query against the
	// appropriate table for each. Highway/railway/waterway are line
	// features (osm_lines); aeroway is queried in both tables because
	// OSM tags airports as both ways (runways, taxiways) and nodes
	// (aerodrome markers, terminals).
	//
	// Cold-miss in a new area: 4 Overpass calls (one per bucket).
	// Serial rather than parallel — each bucket's response can be
	// 5-50 MB JSON in dense urban bboxes (especially highway and
	// landmark). Four in flight at once OOM'd a 256 MB pod. Serial
	// keeps the memory peak at ~1× response, with the same total
	// wall time on cold-miss (each Overpass mirror is the bottleneck,
	// not the local node). Steady-state: 4 indexed SQL queries below.
	await ensureCovered(lat, lon, radiusM, "highway");
	await ensureCovered(lat, lon, radiusM, "railway");
	await ensureCovered(lat, lon, radiusM, "waterway");
	await ensureCovered(lat, lon, radiusM, "aeroway");
	const [highways, railways, waterways, aerowayLines, aerowayPoints] = await Promise.all([
		queryLines(lat, lon, radiusM, "highway"),
		queryLines(lat, lon, radiusM, "railway"),
		queryLines(lat, lon, radiusM, "waterway"),
		queryLines(lat, lon, radiusM, "aeroway"),
		queryPoints(lat, lon, radiusM, "aeroway"),
	]);
	const ways: NearbyWay[] = [];
	for (const f of highways)
		ways.push({ type: "highway", subtype: f.subtype ?? "", name: f.name ?? undefined, distanceM: f.distance_m });
	for (const f of railways)
		ways.push({ type: "railway", subtype: f.subtype ?? "", name: f.name ?? undefined, distanceM: f.distance_m });
	for (const f of waterways)
		ways.push({ type: "waterway", subtype: f.subtype ?? "", name: f.name ?? undefined, distanceM: f.distance_m });
	for (const f of aerowayLines)
		ways.push({ type: "aeroway", subtype: f.subtype ?? "", name: f.name ?? undefined, distanceM: f.distance_m });
	for (const f of aerowayPoints)
		ways.push({ type: "aeroway", subtype: f.subtype ?? "", name: f.name ?? undefined, distanceM: f.distance_m });
	return ways;
}

/**
 * Drivable street geometry within `radiusM` of a point — the full
 * `OsmRoadWay` polylines the road map-matcher (`road-match.ts`) routes a
 * driving / bus leg onto. Ensures the local mirror covers the area (one
 * Overpass fetch on a cold miss, indexed SQL otherwise), then reads the
 * geometry. Unlike `nearbyWays`, which returns only distances, this carries
 * the ordered coordinates the matcher needs.
 */
export async function drivableRoads(lat: number, lon: number, radiusM = 600): Promise<OsmRoadWay[]> {
	await ensureCovered(lat, lon, radiusM, "highway");
	return queryDrivableRoads(lat, lon, radiusM);
}

/**
 * Walkable way geometry within `radiusM` of a point — the network the
 * pedestrian map-matcher (`pedestrian-match.ts`) snaps a foot leg onto.
 * Same shape as {@link drivableRoads} with the walkable subtype set (footways/
 * paths/pedestrian + minor roads people walk along). Ensures coverage, reads
 * the local mirror.
 */
export async function walkableRoads(lat: number, lon: number, radiusM = 600): Promise<OsmRoadWay[]> {
	await ensureCovered(lat, lon, radiusM, "highway");
	return queryWalkableRoads(lat, lon, radiusM);
}

/**
 * Building footprints near a point — impassable polygons the pedestrian
 * smoother pushes a foot leg *out of* (the walkable-surface field's "≈0 inside
 * a building" term). Ensures a tight building-coverage box (see
 * `BOX_HALF_WIDTH_BY_FEATURE` in osm-local — deliberately small, buildings are
 * dense and we only need the immediate block), then reads the local mirror.
 */
export async function nearbyBuildings(lat: number, lon: number, radiusM = 150): Promise<BuildingFootprint[]> {
	await ensureCovered(lat, lon, radiusM, "building");
	return queryBuildingsNear(lat, lon, radiusM);
}

/**
 * Refine a transport mode based on nearby ways and observed speed.
 *
 * Examples:
 * - Mode "driving" + nearby motorway → confidence boost, name "A2"
 * - Mode "driving" + nearby rail at high speed → likely train, not car
 * - Mode "stationary" + nearby aeroway → likely at airport
 */
export interface ModeRefinement {
	mode: TransportMode;
	confidence: "low" | "medium" | "high";
	reason: string;
	wayName?: string;
	/** Forward-load-bearing field for the Phase 3 explanation UI.
	 *  Populated when `USE_FACTOR_SCORER=1` is set in the env;
	 *  carries the per-candidate factor breakdown the panel renders.
	 *  Undefined under the legacy rule-cascade path. */
	factorBreakdown?: ScoredRefinement;
}

/** Highway subtypes that cars can't be on. Used by `pickBestHighway`
 *  to skip a closer pedestrian-only way when the segment is clearly
 *  vehicular (speed > 30 km/h). */
const PEDESTRIAN_HIGHWAY_SUBTYPES = new Set(["footway", "path", "pedestrian", "cycleway", "bridleway", "steps"]);

/** Pick the highway from `highways` (ordered closest-first) that best
 *  represents what the user is on. At driving speed, skip pedestrian-
 *  only ways and return the closest driveable road; if none are in
 *  range, fall back to the closest pedestrian way so the label still
 *  reflects what the mirror sees. At walking/ambiguous speeds, just
 *  return the closest. */
function pickBestHighway(highways: NearbyWay[], speedKmh: number): NearbyWay {
	if (speedKmh > 30) {
		const driveable = highways.find((h) => !PEDESTRIAN_HIGHWAY_SUBTYPES.has(h.subtype));
		if (driveable) return driveable;
	}
	return highways[0];
}

/** How far a named way may sit from the pavement and still be the street that
 *  pavement belongs to. A pavement runs a few metres from its carriageway's
 *  centreline; a wide dual carriageway (Euston Road) reaches ~25 m. Beyond
 *  that it is a different street — a road at the far edge of the park you are
 *  walking through — and naming the walk after it would be exactly the
 *  confidently-wrong label we are trying to stop emitting. */
const WALK_NAME_BORROW_MAX_M = 30;

/** Ceiling below which a segment is moving at pedestrian pace, and a nearby
 *  unnamed footway is plausibly the pavement the user is on. */
const WALK_NAME_BORROW_MAX_KMH = 10;

/**
 * Name a walk after the street its pavement belongs to.
 *
 * OSM models a street's pavement and its carriageway as two separate ways at
 * the same physical place, and the pavement is almost always unnamed. So the
 * way *closest* to a walking GPS fix is an anonymous `footway`, and reading its
 * `.name` renders the leg with no street at all — even though the street is
 * sitting right there in the same result set, a few metres away.
 *
 * The pavement is genuinely where the user is, so it must keep deciding the
 * MODE (see `pickBestHighway`). It simply cannot supply the NAME. This borrows
 * the name of the nearest named way within {@link WALK_NAME_BORROW_MAX_M},
 * returning undefined when nothing is close enough to be the same street.
 *
 * The bug was masked for as long as walks were glued to the rides that
 * followed them: the ride's speed pushed `avgSpeed` past the 30 km/h bar into
 * `pickBestHighway`'s driveable branch, which skips pedestrian ways and picks
 * the road. Those labels were right by accident of a wrong speed
 * (2026-07-01 "walking on Euston Road"). Once `splitWalksOnVehicleLeg` gives a
 * remainder its own honest kinematics, the accident stops happening and the
 * underlying gap shows — so this is the other half of that fix, not a separate
 * concern.
 *
 * The driving side of this asymmetry was fixed long ago (#99: prefer a
 * driveable road over a closer footway). This is its pedestrian sibling, and
 * mirrors the factor scorer's named/unnamed same-mode dedup, which is grounded
 * in the same OSM duplication.
 */
function borrowStreetName(highways: readonly NearbyWay[]): string | undefined {
	let best: NearbyWay | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const h of highways) {
		if (!h.name) continue;
		const d = h.distanceM ?? Number.POSITIVE_INFINITY;
		if (d < bestDist) {
			bestDist = d;
			best = h;
		}
	}
	return bestDist <= WALK_NAME_BORROW_MAX_M ? best?.name : undefined;
}

export interface RailRoadProximity {
	/** Mean distance (m) to the nearest rail-only way across the
	 *  segment's sample points where any rail-only way was in range.
	 *  Null when no sample had rails nearby. */
	meanRailDistM: number | null;
	/** Mean distance (m) to the nearest drivable highway across the
	 *  segment's sample points where any drivable highway was in range.
	 *  Null when no sample had roads nearby. */
	meanDrivableRoadDistM: number | null;
}

export function refineMode(
	originalMode: TransportMode,
	speedKmh: number,
	ways: NearbyWay[],
	biometric?: BiometricContext,
	confidenceMargin?: number,
	debugLabel?: string,
	railRoad?: RailRoadProximity,
): ModeRefinement {
	if (useFactorScorer()) {
		return refineModeViaFactors(originalMode, speedKmh, ways, biometric, confidenceMargin, debugLabel, railRoad);
	}
	return refineModeLegacyCascade(originalMode, speedKmh, ways);
}

/** Maximum sustained speed (km/h) plausibly attainable on a non-
 *  motorway road. UK urban limit is 30 mph (48 km/h); UK A-road urban
 *  dual-carriageway limit is 50 mph (80 km/h). Above this on a non-
 *  motorway way the only physically plausible mode is rail. */
const URBAN_NON_MOTORWAY_MAX_KMH = 80;

/** Highway subtypes that allow legitimate sustained vehicle speeds
 *  > URBAN_NON_MOTORWAY_MAX_KMH. Anything else is a city / arterial
 *  road, regardless of whether OSM tags it "trunk" (which in central
 *  London often means the surface road over an Underground tunnel,
 *  not a real fast-driving artery). */
const MOTORWAY_GRADE_SUBTYPES = new Set(["motorway", "motorway_link"]);

/** Max distance (m) at which a parallel subway counts as evidence
 *  that the segment is actually on the tube under the road, not on
 *  the road itself. Generous because surface GPS over an Underground
 *  station typically sits 20-50 m from the line's mapped geometry. */
const SUBWAY_PARALLEL_DISTANCE_M = 100;

/**
 * Post-`refineMode` physical-plausibility rule for the "tube ride
 * labelled as driving" case. Motivating pattern: a 21-min tube ride
 * with maxSpeed ~99 km/h ended up labelled "driving on Trunk Road"
 * because that road was the closest OSM way at the segment's surface
 * GPS fixes, and the legacy cascade preferred it over the subway
 * line running below.
 *
 * Rule: when the refined label is `driving` AND the segment's max
 * speed exceeds the urban-non-motorway limit AND the user is not on
 * a motorway-grade way AND a subway is parallel to the track,
 * demote to `train` with the subway's wayName. The three conditions
 * together rule out legitimate fast-driving cases:
 *   - on a motorway → kept as driving (motorway speeds are legal)
 *   - no subway within range → kept as driving (no rail alternative;
 *     could be a real fast urban drive that's still mislabelled by
 *     speed-limit standards, but with no rail there we have no
 *     better candidate)
 *   - speed under the threshold → kept as driving (could plausibly
 *     be a slow urban journey)
 *
 * This is a targeted patch with a clear contract, not probabilistic.
 * The HMM-shaped fix (`docs/proposals/2026-05-scored-classification.md`)
 * would subsume this rule along with the cadence-veto, HR-veto, and
 * mergeAdjacentStays bridge; track it as another patch deferring
 * that rewrite (see [[health-sync-hmm-debt]] memory).
 */
export function rejectImplausibleDriving(
	refined: { mode: TransportMode; wayName?: string },
	maxSpeedKmh: number,
	ways: NearbyWay[],
): { mode: TransportMode; wayName?: string; reason?: string } {
	if (refined.mode !== "driving") return refined;
	if (maxSpeedKmh <= URBAN_NON_MOTORWAY_MAX_KMH) return refined;
	const onMotorway = ways.some((w) => w.type === "highway" && MOTORWAY_GRADE_SUBTYPES.has(w.subtype));
	if (onMotorway) return refined;
	const subwayNearby = ways.find(
		(w) =>
			w.type === "railway" &&
			w.subtype === "subway" &&
			(w.distanceM ?? Number.POSITIVE_INFINITY) < SUBWAY_PARALLEL_DISTANCE_M,
	);
	if (!subwayNearby) return refined;
	return {
		mode: "train",
		wayName: subwayNearby.name,
		reason: `${Math.round(maxSpeedKmh)} km/h max exceeds urban non-motorway limit; subway in range`,
	};
}

/**
 * Factor-scorer path. Wraps the candidate generator + aggregator
 * and converts the resulting ScoredRefinement back to the legacy
 * ModeRefinement return shape (so downstream consumers don't need
 * to change yet).
 *
 * Base stack (always active under `USE_FACTOR_SCORER=1`):
 *   - speed-emission (in speedKmh-only mode — refineMode's segment-
 *     level speed is enough to keep walking from winning at urban
 *     speeds without requiring the upstream WindowFeatures).
 *   - osm-distance (per-candidate way distance).
 *   - mode-coherence (mode × way-subtype compatibility).
 *
 * Biometric stack (added when `biometric` is provided — gated upstream
 * by `useBiometricFactor()` in `velocity.ts`):
 *   - biometric-ll (per-mode HR/cadence/speed log-likelihood).
 *   - mode-prior (asymmetric flip rules — cycling is rare for this
 *     user).
 *   - classifier-prior (stickiness on the upstream-classified mode
 *     scaled by `confidenceMargin`; replaces the cascade's binary
 *     `RELABEL_MAX_MARGIN` gate).
 *
 * The biometric stack is gated on `biometric` rather than on a fresh
 * env-flag read so the factor set is a single-source-of-truth function
 * of what the caller has decided to provide.
 */
function refineModeViaFactors(
	originalMode: TransportMode,
	speedKmh: number,
	ways: NearbyWay[],
	biometric?: BiometricContext,
	confidenceMargin?: number,
	debugLabel?: string,
	railRoad?: RailRoadProximity,
): ModeRefinement {
	const candidates = generateRefineModeCandidates(originalMode, ways, biometric);
	const factors: Factor[] = [speedEmission, osmDistance, modeCoherence];
	if (biometric) factors.push(biometricLL, modePrior, classifierPrior);
	if (railRoad) factors.push(railCorridor);
	const ranked = scoreCandidates(
		candidates,
		{
			speedKmh,
			biometricObs: biometric?.obs,
			modeStats: biometric?.stats,
			originalMode,
			confidenceMargin,
			meanRailDistM: railRoad?.meanRailDistM ?? null,
			meanDrivableRoadDistM: railRoad?.meanDrivableRoadDistM ?? null,
		},
		factors,
	);
	// TEMP debug — remove after Phase 1 calibration. Dumps every
	// candidate's score so we can diagnose unexpected fallback wins.
	if (process.env.FACTOR_DEBUG === "1") {
		const fmt = (c: {
			mode: string;
			wayName?: string;
			waySubtype?: string;
			totalScore: number;
			factors: { name: string; score: number }[];
		}): string =>
			`    ${c.totalScore.toFixed(2).padStart(7)} ${c.mode}${c.wayName ? ` "${c.wayName}"` : ""}${c.waySubtype ? ` (${c.waySubtype})` : ""} ← ${c.factors.map((f) => `${f.name}=${f.score.toFixed(2)}`).join(" ")}`;
		const label = debugLabel ? ` ${debugLabel}` : "";
		// Show top of each mode so we can compare across modes, not just within walking.
		const bestPerMode = new Map<string, (typeof ranked.alternatives)[number]>();
		for (const c of [ranked.best, ...ranked.alternatives]) {
			if (!bestPerMode.has(c.mode)) bestPerMode.set(c.mode, c);
		}
		console.log(
			`[factor-debug]${label} originalMode=${originalMode} speed=${speedKmh.toFixed(1)} margin=${(confidenceMargin ?? 0).toFixed(2)} ways=${ways.length} cand=${candidates.length} biometric=${biometric ? "yes" : "no"}\n` +
				`  BEST: ${fmt(ranked.best)}\n` +
				[...bestPerMode.entries()]
					.filter(([m]) => m !== ranked.best.mode)
					.map(([, c]) => `  per-mode-best ${fmt(c)}`)
					.join("\n"),
		);
	}
	return {
		mode: ranked.best.mode,
		wayName: ranked.best.wayName,
		confidence: confidenceFromMargin(ranked.margin),
		reason: reasonFromBest(ranked),
		factorBreakdown: ranked,
	};
}

function confidenceFromMargin(margin: number): "low" | "medium" | "high" {
	if (margin > 2) return "high";
	if (margin > 0.5) return "medium";
	return "low";
}

function reasonFromBest(ranked: ScoredRefinement): string {
	// The "way attached" indicator is the candidate's subtype, not its
	// name — many OSM ways (esp. footways) have no name tag, and a
	// subtyped-but-unnamed candidate is still way-attached, not a
	// fallback. The wayName, when present, gets included separately.
	if (ranked.best.waySubtype) {
		const name = ranked.best.wayName ? ` "${ranked.best.wayName}"` : "";
		return `on ${ranked.best.waySubtype}${name}`;
	}
	return `${ranked.best.mode} (no way context)`;
}

function refineModeLegacyCascade(originalMode: TransportMode, speedKmh: number, ways: NearbyWay[]): ModeRefinement {
	const railways = ways.filter((w) => w.type === "railway");
	const highways = ways.filter((w) => w.type === "highway");
	const aeroways = ways.filter((w) => w.type === "aeroway");
	const waterways = ways.filter((w) => w.type === "waterway");

	// Aeroway near a fast or stationary point
	if (aeroways.length > 0) {
		const aero = aeroways[0];
		if (aero.subtype === "runway" || aero.subtype === "taxiway") {
			return { mode: "plane", confidence: "high", reason: "on runway/taxiway", wayName: aero.name };
		}
		return { mode: "stationary", confidence: "high", reason: "at airport", wayName: aero.name };
	}

	// Major highways present? Roads vastly outnumber rails — when both match,
	// the user is more likely on the road. Used both as a tie-break and as
	// rebuttal evidence against a classifier "train" call below.
	const majorHighways = highways.filter((h) => ["motorway", "trunk", "primary", "secondary"].includes(h.subtype));

	// Railway → train. The naive rule "any rail nearby → train" gets
	// hijacked by rail running parallel to motorways (a freight line
	// alongside a motorway). The naive opposite rule "any major highway
	// nearby → not train" gets hijacked by tube lines running under
	// urban arterials.
	// Distance-aware tie-break when distance info is available: prefer
	// whichever feature the GPS trajectory was actually closer to.
	// Back-compat: when distances are missing (older callers, tests),
	// fall back to the original presence-based rule.
	if (railways.length > 0 && speedKmh > 30) {
		const railMinM = Math.min(...railways.map((r) => r.distanceM ?? Number.POSITIVE_INFINITY));
		const hwyMinM =
			majorHighways.length > 0
				? Math.min(...majorHighways.map((h) => h.distanceM ?? Number.POSITIVE_INFINITY))
				: Number.POSITIVE_INFINITY;
		const haveDistanceInfo = Number.isFinite(railMinM) || Number.isFinite(hwyMinM);
		const preferRail = haveDistanceInfo ? railMinM <= hwyMinM : majorHighways.length === 0;
		if (preferRail) {
			const rail = railways[0];
			return {
				mode: "train",
				confidence: "high",
				reason: `on ${rail.subtype}`,
				wayName: rail.name,
			};
		}
	}

	// Classifier said "train" but no rail anywhere in our samples — almost
	// certainly motorway cruise control (high linearity + steady ~100 km/h
	// matches the train profile). Downgrade to driving.
	if (originalMode === "train" && railways.length === 0) {
		if (majorHighways.length > 0) {
			const hw = majorHighways[0];
			return { mode: "driving", confidence: "high", reason: `on ${hw.subtype}`, wayName: hw.name };
		}
		return { mode: "driving", confidence: "medium", reason: "no rail evidence" };
	}

	// Highway match. At driving speed (> 30 km/h), prefer a driveable
	// road over a pedestrian-only way that just happens to be closer.
	// Urban GPS routinely lands on the pavement: a footway can sit 20m
	// away from a road centred at 27m, and a blind `highways[0]` pick
	// then labels the drive "near footway". Walking and ambiguous mid-
	// range speeds keep the simple closest-first pick — at those speeds
	// the footway really might be where the user is.
	if (highways.length > 0) {
		const hw = pickBestHighway(highways, speedKmh);
		// The picked way decides the mode. When it is an unnamed pavement, the
		// street it belongs to supplies the name — see `borrowStreetName`.
		const hwName = hw.name ?? (speedKmh < WALK_NAME_BORROW_MAX_KMH ? borrowStreetName(highways) : undefined);
		// Pedestrian-only highways
		if (hw.subtype === "footway" || hw.subtype === "path" || hw.subtype === "pedestrian") {
			if (speedKmh < 10) return { mode: "walking", confidence: "high", reason: `on ${hw.subtype}`, wayName: hwName };
		}
		if (hw.subtype === "cycleway") {
			return { mode: "cycling", confidence: "high", reason: "on cycleway", wayName: hw.name };
		}
		if (hw.subtype === "motorway" || hw.subtype === "trunk" || hw.subtype === "primary") {
			if (speedKmh > 30) {
				return { mode: "driving", confidence: "high", reason: `on ${hw.subtype}`, wayName: hw.name };
			}
		}
		// Generic road — for secondary/tertiary/residential/service at driving
		// speeds, this is the path that produces "on Great Central Way" labels.
		if (speedKmh > 30 && !PEDESTRIAN_HIGHWAY_SUBTYPES.has(hw.subtype)) {
			return { mode: originalMode, confidence: "medium", reason: `on ${hw.subtype}`, wayName: hw.name };
		}
		return { mode: originalMode, confidence: "medium", reason: `near ${hw.subtype}`, wayName: hwName };
	}

	// On a navigable waterway → boat. Excludes drains, ditches, streams (too small).
	const navigableWaterways = waterways.filter((w) => ["river", "canal", "fairway"].includes(w.subtype));
	if (navigableWaterways.length > 0 && speedKmh > 3 && speedKmh < 50) {
		const ww = navigableWaterways[0];
		return { mode: "boat", confidence: "medium", reason: `on ${ww.subtype}`, wayName: ww.name };
	}

	// No useful OSM context — keep original
	return { mode: originalMode, confidence: "low", reason: "no OSM context" };
}
