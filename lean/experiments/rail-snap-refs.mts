/**
 * V8 reference values for the Lean port of `src/geo/rail-snap.ts` — the
 * fix-cloud-weighted rail-network snapper.
 *
 * Boundary: `buildRailGraph`'s vertex fusion keys a vertex by
 * `` `${lat.toFixed(7)},${lon.toFixed(7)}` `` — string-keyed coordinate fusion,
 * which stays SHELL exactly as `walkable-route.ts`'s `nodeKey` does. So this
 * harness also emits, for each way, the fused vertex id of each of its
 * coordinates: that is the input the Lean twin is given, and everything
 * downstream of the fusion (edge order, weights, gap bridging, Dijkstra, the
 * snap decisions) is what the port reproduces.
 *
 * `shortestPathViaLean` is a no-op when `LEAN_RAIL` is unset (mode "off"
 * returns the TS path), so these references pin the pure TS search.
 *
 * The private helpers `cloudPenalty`, `edgeWeight`, `bridgeGaps` and
 * `wayOnLine` have no exported entry point; they are read out of the adjacency
 * weights `buildRailGraph` returns, and out of `snapTrainSegmentOnLine`.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/rail-snap-refs.mts
 */

import {
	FixCloud,
	buildRailGraph,
	interpolateTimes,
	nearestVertex,
	parseRailWayName,
	resolveStation,
	shortestPath,
	snapTrainSegment,
	snapTrainSegmentOnLine,
	type OsmLine,
	type OsmStation,
	type RailGeometry,
	type SnapResult,
} from "../../src/geo/rail-snap.js";
import { parseLineMemberships } from "../../src/geo/route-graph.js";

if (process.env.LEAN_RAIL !== undefined) throw new Error("unset LEAN_RAIL: these references pin the TS search");

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

// --- local metric frame ----------------------------------------------------
const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** (north metres, east metres) → lat/lon. */
const P = (n: number, e: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });
type Coord = [number, number];
const C = (n: number, e: number): Coord => {
	const p = P(n, e);
	return [p.lat, p.lon];
};

const line = (osmId: number, name: string | null, subtype: string | null, coords: Coord[]): OsmLine => ({
	osmId,
	name,
	subtype,
	coords,
});

// Two parallel lines 300 m apart, joined by connectors at e=500 and e=1000.
// MAIN carries Alpha (e=0) and Beta (e=1000); NORTH is the detour.
const MAIN = line(1, "Metropolitan Line", "rail", [C(0, 0), C(0, 250), C(0, 500), C(0, 750), C(0, 1000)]);
const NORTH = line(2, "Piccadilly Line", "subway", [C(300, 0), C(300, 500), C(300, 1000)]);
const CONN_MID = line(3, "Metropolitan Line", "rail", [C(0, 500), C(150, 500), C(300, 500)]);
const CONN_END = line(4, "Metropolitan Line", "rail", [C(0, 1000), C(150, 1000), C(300, 1000)]);
// A separate way continuing MAIN east, starting 10 m past its end: no shared
// node, so only gap bridging (≤ 15 m) connects it.
const SPUR = line(5, "Metropolitan Line", "rail", [C(0, 1010), C(0, 1200)]);
// Excluded by RAIL_SUBTYPES — a tram is not a train.
const TRAM = line(6, "Tram Line", "tram", [C(0, 0), C(0, 1000)]);

const LINES = [MAIN, NORTH, CONN_MID, CONN_END, SPUR, TRAM];

const station = (name: string | null, n: number, e: number): OsmStation => ({
	name,
	subtype: "station",
	...P(n, e),
});
// Alpha appears as two nodes a few metres apart — the centroid is the anchor.
const STATIONS: OsmStation[] = [
	station("Alpha", 2, 0),
	station("Alpha", -2, 0),
	station("Beta", 0, 1000),
	station("Gamma", 300, 1000),
	station("Nowhere", 5000, 5000),
];
const GEO: RailGeometry = { lines: LINES, wayRoutes: [], stations: STATIONS };

/** Fixes hugging a given northing, dense enough to clear MIN_CLOUD_FIXES. */
const cloudAlong = (n: number, count: number): Array<{ lat: number; lon: number }> =>
	Array.from({ length: count }, (_, i) => P(n, (i * 1000) / (count - 1)));

const lines_: string[] = [];
const say = (label: string, value: string): void => lines_.push(`${label} = ${value}`);
const section = (name: string): void => lines_.push(`\n=== ${name} ===`);

/**
 * Emit the fused net for a set of ways: the vertex list and, per way, the
 * vertex id of each of its RAW coordinates. This is the shell-side half of
 * `buildRailGraph` — the Lean twin is handed exactly this and rebuilds the
 * adjacency from it, so a net is needed per scenario (a line-restricted search
 * fuses a different way set and therefore numbers its vertices differently).
 */
const dumpNet = (label: string, ways: OsmLine[], cloud: FixCloud): void => {
	const g = buildRailGraph(ways, cloud);
	say(`${label} vertices`, String(g.vertices.length));
	g.vertices.forEach((v, i) => say(`${label} v[${i}]`, `${f(v.lat)},${f(v.lon)}`));
	g.adj.forEach((row, i) => say(`${label} adj[${i}]`, row.map((e) => `${e.to}:${f(e.w)}`).join(" ")));
	for (const l of ways) {
		if (!["rail", "subway", "light_rail", "narrow_gauge"].includes(l.subtype ?? "")) continue;
		const ids = l.coords.map(([lat, lon]) => {
			const idx = g.vertices.findIndex((v) => v.lat === lat && v.lon === lon);
			if (idx < 0) throw new Error(`way ${l.osmId} coord not fused to a vertex`);
			return idx;
		});
		say(`${label} vids way ${l.osmId}`, ids.join(","));
	}
};

// ------------------------------------------------------------ parsing -----
section("parseRailWayName");
for (const s of [
	"Alpha → Beta",
	"Alpha → Beta · Metropolitan Line",
	"Alpha & Sons → Beta · Circle Line",
	"Alpha → Beta · ",
	"Alpha → ",
	" → Beta",
	"Alpha - Beta",
	"",
]) {
	const r = parseRailWayName(s);
	say(`parse ${JSON.stringify(s)}`, r === null ? "null" : `${r.board}|${r.alight}|${r.line ?? "null"}`);
}

section("parseLineMemberships");
for (const s of [
	"Metropolitan Line",
	"Hammersmith & City Line",
	"Circle, Hammersmith & City and Metropolitan Lines",
	"Metropolitan and Piccadilly Line",
	"Jubilee Line Eastbound",
	"Circle Line Inner Rail",
	"Metropolitan Line Westbound Extra",
	"District",
	"",
	" Line",
	"A,  B and C Lines",
]) {
	const set = parseLineMemberships(s);
	say(`memberships ${JSON.stringify(s)}`, `[${[...set].join("|")}]`);
}
say("memberships null", `[${[...parseLineMemberships(null)].join("|")}]`);

// ------------------------------------------------------------ stations ----
section("resolveStation");
for (const n of ["Alpha", "Beta", "Missing"]) {
	const r = resolveStation(n, STATIONS);
	say(`resolve ${n}`, r === null ? "null" : `${f(r.lat)},${f(r.lon)}`);
}

// ----------------------------------------------------------- fix cloud ----
section("FixCloud");
{
	const cloud = new FixCloud(cloudAlong(0, 21));
	for (const [n, e, label] of [
		[0, 500, "on the corridor"],
		[50, 500, "50 m off"],
		[300, 500, "300 m off"],
		[900, 500, "900 m off (capped)"],
	] as Array<[number, number, string]>) {
		const p = P(n, e);
		say(`cloud ${label}`, f(cloud.nearestDist(p.lat, p.lon)));
	}
	const empty = new FixCloud([]);
	const p = P(0, 0);
	say("empty cloud", f(empty.nearestDist(p.lat, p.lon)));
}

// --------------------------------------------------------------- graph ----
section("buildRailGraph");
{
	const cloud = new FixCloud(cloudAlong(0, 21));
	const g = buildRailGraph(LINES, cloud);
	dumpNet("all", LINES, cloud);
	// Each scenario's own fusion: a line-restricted way set numbers its
	// vertices differently, so the Lean twin needs the matching net.
	dumpNet("north-cloud", LINES, new FixCloud(cloudAlong(300, 21)));
	dumpNet("metropolitan", [MAIN, CONN_MID, CONN_END, SPUR], new FixCloud([]));
	dumpNet("piccadilly", [NORTH], new FixCloud([]));
	dumpNet("split", [MAIN, NORTH], cloud);

	say("nearestVertex Alpha", JSON.stringify(nearestVertex(g, resolveStation("Alpha", STATIONS)!)));
	say("nearestVertex Nowhere", JSON.stringify(nearestVertex(g, resolveStation("Nowhere", STATIONS)!)));
	const empty = buildRailGraph([TRAM], cloud);
	say("tram-only vertices", String(empty.vertices.length));
	say("nearestVertex on empty", String(nearestVertex(empty, P(0, 0))));
}

section("shortestPath");
{
	const onMain = buildRailGraph(LINES, new FixCloud(cloudAlong(0, 21)));
	const viaNorth = buildRailGraph(LINES, new FixCloud(cloudAlong(300, 21)));
	const a = nearestVertex(onMain, resolveStation("Alpha", STATIONS)!)!;
	const b = nearestVertex(onMain, resolveStation("Beta", STATIONS)!)!;
	say("cloud on MAIN path", String(shortestPath(onMain, a.id, b.id)));
	say("cloud on NORTH path", String(shortestPath(viaNorth, a.id, b.id)));
	say("same vertex path", String(shortestPath(onMain, a.id, a.id)));
	// A vertex island: the tram way is excluded, so a graph of only NORTH and
	// MAIN with no connectors leaves the two disconnected.
	const split = buildRailGraph([MAIN, NORTH], new FixCloud(cloudAlong(0, 21)));
	const sa = nearestVertex(split, resolveStation("Alpha", STATIONS)!)!;
	const sg = nearestVertex(split, resolveStation("Gamma", STATIONS)!)!;
	say("disconnected path", String(shortestPath(split, sa.id, sg.id)));
}

section("interpolateTimes");
{
	const pts = interpolateTimes([P(0, 0), P(0, 250), P(0, 1000)], 1000, 1300);
	pts.forEach((p, i) => say(`interp[${i}]`, `${f(p.lat)},${f(p.lon)},${f(p.ts)}`));
	const one = interpolateTimes([P(0, 0)], 1000, 1300);
	say("interp single ts", f(one[0].ts));
	const dup = interpolateTimes([P(0, 0), P(0, 0)], 1000, 1300);
	say("interp zero-length ts", `${f(dup[0].ts)},${f(dup[1].ts)}`);
}

// ---------------------------------------------------------------- snap ----
section("snapTrainSegment");
{
	const report = (label: string, r: SnapResult | null): void => {
		if (r === null) {
			say(`${label} result`, "null");
			return;
		}
		say(`${label} board`, `${r.board.name} ${f(r.board.lat)},${f(r.board.lon)}`);
		say(`${label} alight`, `${r.alight.name} ${f(r.alight.lat)},${f(r.alight.lon)}`);
		say(`${label} line`, String(r.line));
		say(`${label} n`, String(r.path.length));
		r.path.forEach((p, i) => say(`${label} path[${i}]`, `${f(p.lat)},${f(p.lon)},${f(p.ts)}`));
	};
	const seg = { startTs: 1000, endTs: 1300, wayName: "Alpha → Beta" };
	report("cloud on MAIN", snapTrainSegment(seg, GEO, cloudAlong(0, 21)));
	report("cloud on NORTH", snapTrainSegment(seg, GEO, cloudAlong(300, 21)));
	report("thin cloud", snapTrainSegment(seg, GEO, cloudAlong(0, 11)));
	report("bad label", snapTrainSegment({ ...seg, wayName: "Alpha - Beta" }, GEO, cloudAlong(0, 21)));
	report("unknown station", snapTrainSegment({ ...seg, wayName: "Alpha → Zeta" }, GEO, cloudAlong(0, 21)));
	report("same station", snapTrainSegment({ ...seg, wayName: "Alpha → Alpha" }, GEO, cloudAlong(0, 21)));
	report("station off network", snapTrainSegment({ ...seg, wayName: "Alpha → Nowhere" }, GEO, cloudAlong(0, 21)));
	report("no lines", snapTrainSegment(seg, { ...GEO, lines: [TRAM] }, cloudAlong(0, 21)));
}

section("snapTrainSegmentOnLine");
{
	const report = (label: string, r: SnapResult | null): void => {
		if (r === null) {
			say(`${label} result`, "null");
			return;
		}
		say(`${label} line`, String(r.line));
		say(`${label} n`, String(r.path.length));
		r.path.forEach((p, i) => say(`${label} path[${i}]`, `${f(p.lat)},${f(p.lon)},${f(p.ts)}`));
	};
	const base = { startTs: 1000, endTs: 1300 };
	report("on Metropolitan", snapTrainSegmentOnLine({ ...base, wayName: "Alpha → Beta · Metropolitan Line" }, GEO));
	report("on Piccadilly", snapTrainSegmentOnLine({ ...base, wayName: "Alpha → Gamma · Piccadilly Line" }, GEO));
	report("no line in label", snapTrainSegmentOnLine({ ...base, wayName: "Alpha → Beta" }, GEO));
	report("unknown line", snapTrainSegmentOnLine({ ...base, wayName: "Alpha → Beta · Bakerloo Line" }, GEO));
	report("same station", snapTrainSegmentOnLine({ ...base, wayName: "Alpha → Alpha · Metropolitan Line" }, GEO));
}

console.log(lines_.join("\n"));
