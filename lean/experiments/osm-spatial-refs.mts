/**
 * V8 reference values for the OSM spatial kernel — the part of
 * `src/geo/osm-local.ts` + `src/geo/osm.ts` that currently runs as SQL inside
 * MariaDB and is being moved into Lean so the spatial predicate becomes a
 * definition rather than an oracle (`docs/proposals/2026-07-osm-into-lean.md`).
 *
 * Two metrics, and they are NOT the same:
 *
 *  - POINTS (`queryPoints`, backing `nearbyStations`) use MariaDB's
 *    `ST_Distance_Sphere`, a great-circle distance on a sphere of radius
 *    6370986 m — measured off the live server, not assumed. Lean's own
 *    haversine uses 6371000; under the new design the DB stops computing
 *    distances at all and Lean's constant becomes the definition, so this
 *    harness pins BOTH so the re-bless delta is visible rather than silent.
 *
 *  - LINES (`queryLines`, backing `linesAtPoint`) use `ST_Distance`, which is
 *    PLANAR in degree space, then multiply by a single `mPerDeg` scale. That is
 *    an anisotropic approximation — at 51°N a degree of longitude is ~62% of a
 *    degree of latitude, and this metric ignores the difference — but it is
 *    what the algorithm has always used, so it is reproduced as-is.
 *
 * The MBR pre-filter is deliberately NOT modelled: `dDeg` is built from
 * `min(111000, 111000·cos lat)`, both of which understate the true metres per
 * degree, so the box strictly contains the radius circle and cannot change the
 * result set. It exists to make the spatial index usable, nothing more.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/osm-spatial-refs.mts
 */

import { dedupeStationsByName } from "../../src/geo/osm.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

/** MariaDB 12.3.2 `ST_Distance_Sphere`, measured: 1 deg lat = 111194.68229846345 m. */
const MARIA_R = 6_370_986;
/** `Verified.Hsmm.FloatScore.haversineMeters`. */
const LEAN_R = 6_371_000;

const hav = (lat1: number, lon1: number, lat2: number, lon2: number, R: number): number => {
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const METERS_PER_DEG_LAT = 111_000;
const metersPerDegLon = (lat: number): number => 111_000 * Math.cos((lat * Math.PI) / 180);
const mPerDegAt = (lat: number): number => Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));

show("mPerDeg@51.52", mPerDegAt(51.52));

// A cluster around a query point at Willesden Green, with a station, two of its
// entrances sharing the name, a nearer entrance of a DIFFERENT station, and one
// feature outside every radius.
const QLAT = 51.5492;
const QLON = -0.2215;

type Row = { osm_id: number; subtype: string; name: string | null; lat: number; lon: number };
const FEATURES: Row[] = [
	{ osm_id: 1, subtype: "station", name: "Willesden Green", lat: 51.54925, lon: -0.22095 },
	{ osm_id: 2, subtype: "subway_entrance", name: "Willesden Green", lat: 51.54921, lon: -0.22141 },
	{ osm_id: 3, subtype: "subway_entrance", name: "Willesden Green", lat: 51.54935, lon: -0.22162 },
	{ osm_id: 4, subtype: "subway_entrance", name: "Dollis Hill", lat: 51.54928, lon: -0.22148 },
	{ osm_id: 5, subtype: "station", name: "Dollis Hill", lat: 51.5520, lon: -0.2390 },
	{ osm_id: 6, subtype: "halt", name: "Far Halt", lat: 51.5600, lon: -0.2500 },
	{ osm_id: 7, subtype: "tram_stop", name: null, lat: 51.54930, lon: -0.22120 },
	// Straddle the 100 m bar so the radius filter is pinned on both sides, and
	// a non-station subtype so the subtype filter is pinned too.
	{ osm_id: 8, subtype: "station", name: "Just In", lat: QLAT + 99 / 111194.68229846345, lon: QLON },
	{ osm_id: 9, subtype: "station", name: "Just Out", lat: QLAT + 101 / 111194.68229846345, lon: QLON },
	{ osm_id: 10, subtype: "level_crossing", name: "Not A Station", lat: 51.54926, lon: -0.22130 },
	// A SECOND Dollis Hill entrance. Its station is out of range, so the winner
	// here is decided by the same-kind distance rule and survives to the output —
	// unlike Willesden Green, where the station outranks both entrances anyway.
	{ osm_id: 12, subtype: "subway_entrance", name: "Dollis Hill", lat: 51.54940, lon: -0.22180 },
	// Exactly on the 100 m bar under MariaDB's 6370986 sphere — and therefore
	// 100.00022 m under Lean's 6371000, i.e. OUT. This is the one place the two
	// radii can actually disagree, and it is what the re-bless may surface.
	{ osm_id: 11, subtype: "station", name: "On The Bar", lat: QLAT + 100 / 111194.68229846345, lon: QLON },
];

const withDist = (rows: Row[], R: number) =>
	rows.map((r) => ({ ...r, distance_m: hav(QLAT, QLON, r.lat, r.lon, R) }));

/** `buildPointsQuery`: radius filter, order by distance, cap at 50. */
const queryPoints = (rows: Row[], radiusM: number, subtypes: string[] | undefined, R: number) => {
	let out = withDist(rows, R).filter((r) => r.distance_m < radiusM);
	if (subtypes && subtypes.length > 0) out = out.filter((r) => subtypes.includes(r.subtype));
	return out.sort((a, b) => a.distance_m - b.distance_m).slice(0, 50);
};

const STATION_SUBTYPES = ["station", "subway_entrance", "halt", "stop", "tram_stop"];

for (const R of [MARIA_R, LEAN_R] as const) {
	const tag = R === MARIA_R ? "maria" : "lean";
	show(`dist.${tag}`, withDist(FEATURES, R).map((r) => [r.osm_id, r.distance_m]));
	for (const radius of [100, 200, 400]) {
		const q = queryPoints(FEATURES, radius, STATION_SUBTYPES, R);
		show(`points.${tag}.r${radius}`, q.map((r) => r.osm_id));
	}
	// Radius set to feature 8's OWN distance: `<` excludes it, `<=` would keep it.
	const d8 = hav(QLAT, QLON, FEATURES[7].lat, FEATURES[7].lon, R);
	show(`points.${tag}.onExactBar`, queryPoints(FEATURES, d8, STATION_SUBTYPES, R).map((r) => r.osm_id));
	// No subtype filter: the level crossing survives, ordered on distance.
	show(`points.${tag}.nofilter100`, queryPoints(FEATURES, 100, undefined, R).map((r) => r.osm_id));
}

// `deriveStationSubtype` is exercised through the real `dedupeStationsByName`,
// which is where the trap lives: a station and its entrances are separate
// points sharing one name, and naive keep-closest picks the ENTRANCE — which
// `pickBestStation` then filters out as entrance-like, deleting the station
// from the result entirely.
const deriveStationSubtype = (f: { subtype: string | null; tags: Record<string, string> }): string => {
	if (f.subtype === "subway_entrance") return "subway_entrance";
	if (f.tags.station === "subway") return "subway";
	if (f.tags.station === "light_rail") return "light_rail";
	if (f.tags.tram === "yes" || f.subtype === "tram_stop") return "tram";
	if (f.subtype === "halt") return "halt";
	return "rail";
};

const TAGGED: Array<{ subtype: string | null; tags: Record<string, string>; expect: string }> = [
	{ subtype: "subway_entrance", tags: { station: "subway" }, expect: "subway_entrance" },
	{ subtype: "station", tags: { station: "subway" }, expect: "subway" },
	{ subtype: "station", tags: { station: "light_rail" }, expect: "light_rail" },
	{ subtype: "station", tags: { tram: "yes" }, expect: "tram" },
	{ subtype: "tram_stop", tags: {}, expect: "tram" },
	{ subtype: "halt", tags: {}, expect: "halt" },
	{ subtype: "station", tags: {}, expect: "rail" },
	{ subtype: null, tags: {}, expect: "rail" },
];
show("subtype", TAGGED.map((t) => deriveStationSubtype(t)));

// Drive the real dedupe. Input is ordered by distance, as the query returns it.
const dedupeIn = queryPoints(FEATURES, 400, STATION_SUBTYPES, MARIA_R).map((r) => ({
	osm_id: r.osm_id,
	osm_type: "node",
	subtype: r.subtype,
	name: r.name,
	distance_m: r.distance_m,
	lat: r.lat,
	lon: r.lon,
	encloses: false,
	tags: {} as Record<string, string>,
	derivedSubtype: deriveStationSubtype({ subtype: r.subtype, tags: {} }),
}));
show("dedupe.in", dedupeIn.map((r) => [r.osm_id, r.name, r.derivedSubtype, r.distance_m]));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
show("dedupe.out", (dedupeStationsByName as any)(dedupeIn).map((r: any) => [r.name, r.subtype, r.distanceM ?? r.distance_m]));
