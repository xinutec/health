import type { OsmAdapter } from "./osm-adapter.js";
import type { TransportMode } from "./segments.js";

/** "You are at the station" footprint: how close a train-alighting stay
 *  must sit to a station node before we name the stay after it. Tight
 *  enough that a café you genuinely walked to (with a walking segment in
 *  between, which also disqualifies it) isn't swallowed by the station. */
export const STATION_AT_ALIGHT_RADIUS_M = 150;

/**
 * Transit continuity for place-naming. A stationary stay immediately
 * preceded by a train, sitting within station range, is at the station
 * the user just alighted at — not at a co-located café the place-picker
 * would otherwise latch onto. Returns the nearest station's name, or
 * null when the preceding segment isn't a train or no station is close
 * enough.
 *
 * Motivated by 2026-05-22: an ambulance wait on the Finchley Road
 * station forecourt (alighted a train, then stood still) was mislabelled
 * "Loft Coffee Company" because the place-picker never consults stations
 * and had no transit context. The immediately-preceding train is the
 * disambiguator — a genuine café visit has a walking segment between the
 * alight and the stay, so `prev` would be walking, not train.
 */
export async function stationAtTrainAlight(
	prev: { mode: TransportMode; refinedMode?: TransportMode } | undefined,
	lat: number,
	lon: number,
	osm: Pick<OsmAdapter, "nearbyStations">,
	radiusM: number = STATION_AT_ALIGHT_RADIUS_M,
): Promise<string | null> {
	if (prev === undefined) return null;
	if ((prev.refinedMode ?? prev.mode) !== "train") return null;
	const stations = await osm.nearbyStations(lat, lon, radiusM);
	if (stations.length === 0) return null;
	const nearest = stations.reduce((a, b) => (b.distanceM < a.distanceM ? b : a));
	return nearest.distanceM <= radiusM ? nearest.name : null;
}

/** A platform-to-platform interchange walk inside a large station complex. Set to
 *  cover genuine long transfers — King's Cross Victoria→Met (the 2026-06-16
 *  phantom "Megaro Hotel") is a ~10-min concourse walk between separate stations
 *  of one interchange. Longer than this is a walk to somewhere. This is a WEAK
 *  discriminator: the venue-vs-interchange call rests on the stay being short
 *  (`INTERCHANGE_DWELL_MAX_S`) AND within station range (`STATION_AT_ALIGHT_RADIUS_M`),
 *  which is what the stay being labelled must satisfy — so a short station-sited
 *  stay bracketed by trains is a change of trains regardless of the transfer
 *  walk's exact length. */
export const INTERCHANGE_WALK_MAX_S = 720;

/** A change of trains is a short wait — a few minutes on the platform. A stay
 *  longer than this, even bracketed by trains, is a genuine destination reached
 *  by one ride and left by a later one (e.g. a hospital appointment between an
 *  outbound and a return train hours apart), not an interchange. */
export const INTERCHANGE_DWELL_MAX_S = 900;

/** Established-focus-place guard: a stay the place prior confidently
 *  assigned to a focus place visited on at least this many distinct days
 *  is a genuine destination, and keeps its label even when train legs
 *  bracket it. Trains on both sides prove a JOURNEY structure — not that
 *  the stop between them was a platform (2026-07-02, user-confirmed: an
 *  RT visit 5 m from the 6-day UCLH focus place, between the morning
 *  tube and a REAL one-stop hop onward, was renamed "Warren Street"
 *  after the station 100 m away; the intervening street walks passed the
 *  short-walk check). One-off focus places stay overridable — the
 *  06-29 Baker Street case this pass exists for must keep working even
 *  if a low-evidence cluster ever mines at a platform. */
export const INTERCHANGE_FOCUS_GUARD_MIN_DAYS = 3;

interface InterchangeSeg {
	mode: TransportMode;
	refinedMode?: TransportMode;
	startTs: number;
	endTs: number;
}

const effMode = (s: InterchangeSeg): TransportMode => s.refinedMode ?? s.mode;
const isShortWalk = (s: InterchangeSeg): boolean =>
	effMode(s) === "walking" && s.endTs - s.startTs <= INTERCHANGE_WALK_MAX_S;

/** Is the segment chain on one side of the stay a train, reached either directly
 *  or across a single short platform-change walk? */
function bracketingTrain(segments: readonly InterchangeSeg[], adjacent: number, beyond: number): boolean {
	const a = segments[adjacent];
	if (a !== undefined && effMode(a) === "train") return true;
	// Skip one short interchange walk and look at the leg beyond it.
	if (a !== undefined && isShortWalk(a)) {
		const b = segments[beyond];
		if (b !== undefined && effMode(b) === "train") return true;
	}
	return false;
}

/**
 * Transit-interchange continuity for place-naming. A stationary stay that sits
 * within station range AND is bracketed by train legs at that station — a train
 * alighting just before (directly, or across one short platform-change walk) and
 * a train boarding just after (likewise) — is a change of trains, not a venue
 * visit. Returns the nearest station's name, or null when the stay isn't
 * transit-bracketed on both sides or no station is close enough.
 *
 * Motivated by 2026-06-29: a Baker Street platform change (alight the
 * Circle/H&C, walk to the Met platform, wait, board the Met) was mislabelled
 * "Krispy Kreme" — a fast-food unit mapped 40 m away inside the station that the
 * venue scorer reached for because the stay had no transit context. The existing
 * `stationAtTrainAlight` misses this: it bails the moment a walk sits between the
 * train and the stay (it assumes a walk means a genuine destination). An
 * interchange breaks that assumption — the walk is platform-to-platform and a
 * train departs the same station right after. Requiring trains on BOTH sides
 * (within one short walk) is what distinguishes a change of trains from
 * alight → walk to a café → walk back → board.
 */
export async function stationAtTransitInterchange(
	segments: readonly InterchangeSeg[],
	i: number,
	lat: number,
	lon: number,
	osm: Pick<OsmAdapter, "nearbyStations">,
	radiusM: number = STATION_AT_ALIGHT_RADIUS_M,
	stayFocusDays?: number,
): Promise<string | null> {
	const stay = segments[i];
	if (stay === undefined || stay.endTs - stay.startTs > INTERCHANGE_DWELL_MAX_S) return null;
	// Established-destination guard — see INTERCHANGE_FOCUS_GUARD_MIN_DAYS.
	if (stayFocusDays !== undefined && stayFocusDays >= INTERCHANGE_FOCUS_GUARD_MIN_DAYS) return null;
	const before = bracketingTrain(segments, i - 1, i - 2);
	const after = bracketingTrain(segments, i + 1, i + 2);
	if (!before || !after) return null;
	const stations = await osm.nearbyStations(lat, lon, radiusM);
	if (stations.length === 0) return null;
	const nearest = stations.reduce((a, b) => (b.distanceM < a.distanceM ? b : a));
	return nearest.distanceM <= radiusM ? nearest.name : null;
}
