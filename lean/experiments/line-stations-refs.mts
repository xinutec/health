#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `src/geo/line-stations.ts`, ported to
 * `Verified/Geo/LineStations.lean`.
 *
 * The `#guard`s in the Lean module were written against the TS by reading; this
 * prints what V8 actually returns for the same inputs, so the two can be
 * compared rather than assumed equal. `lineBaseToken` is where that matters
 * most — it is a hand-rolled port of a regex (`/\s+lines?\b.*$/i`), and the
 * backtracking behaviour around `lines?\b` is the kind of thing that reads
 * obviously right and is obviously wrong.
 *
 * Run: npx tsx lean/experiments/line-stations-refs.mts
 */
import * as L from "../../src/geo/line-stations.js";

const q = (s: string) => JSON.stringify(s);

console.log("-- lineBaseToken");
for (const name of [
	"Victoria Line",
	"Circle and District Lines",
	"North London line",
	"Northern Line (Bank Branch)",
	"Northern Line (Charing Cross Branch) Southbound",
	"Victoria Line Northbound",
	"514a",
	"Belsize Fast Tunnel",
	"SPC1",
	"Line 1",
	"Wembley Lineside Path",
	"A Line and B Line",
	"London–Aylesbury Line",
	" Line",
]) {
	console.log(`#guard lineBaseToken ${q(name)} == ${q(L.lineBaseToken(name))}`);
}

const MIRROR = [
	"Victoria Line",
	"Victoria Line Northbound",
	"Bakerloo Line",
	"North London line",
	"North London Line Connection",
	"Circle and District Lines",
	"Metropolitan Line",
];

console.log("\n-- lineNamesMatching (mirror = mirrorNames in the Lean guards)");
for (const name of ["Victoria Line", "Victoria Line Northbound", "North London line", "VICTORIA LINE", "Jubilee Line", " Line"]) {
	const got = L.lineNamesMatching(name, MIRROR) as string[];
	console.log(`${name.padEnd(26)} → #[${got.map(q).join(", ")}]`);
}

console.log("\n-- pointToLineDistanceM, north-south way at lon 0 (via the WKT entry point)");
const NS_WKT = "LINESTRING(0 -0.01,0 0.01)";
for (const [lat, lon, label] of [
	[0, 0, "on the line"],
	[0, 200 / 111_320, "200 m east"],
	[0, 400 / 111_320, "400 m east"],
	[0.02, 0, "past the end"],
] as Array<[number, number, string]>) {
	console.log(`${label.padEnd(14)} ${L.pointToLineDistanceM(lat, lon, NS_WKT)}`);
}
// Degenerate geometry: the TS returns Infinity below two vertices, and takes the
// `len2 === 0` branch for a repeated vertex.
console.log(`one vertex    ${L.pointToLineDistanceM(0, 0, "LINESTRING(0 0)")}`);
console.log(`repeated      ${L.pointToLineDistanceM(0, 0, "LINESTRING(0 0,0 0)")}`);

console.log("\n-- filterStationsByLineProximity");
const stations = [
	{ name: "On It", lat: 0, lon: 0 },
	{ name: "Just Inside", lat: 0.005, lon: 250 / 111_320 },
	{ name: "Just Outside", lat: 0.005, lon: 350 / 111_320 },
	{ name: "Far Away", lat: 0, lon: 5000 / 111_320 },
];
const ways = [{ wkt: NS_WKT }];
const names = (xs: Array<{ name: string }>) => xs.map((s) => s.name);
console.log(`kept          [${names(L.filterStationsByLineProximity(stations, ways)).join(", ")}]`);
console.log(`reversed      [${names(L.filterStationsByLineProximity([...stations].reverse(), ways)).join(", ")}]`);
console.log(
	`duplicate     ${L.filterStationsByLineProximity(
		[
			{ name: "On It", lat: 0, lon: 0 },
			{ name: "On It", lat: 0.002, lon: 0 },
		],
		ways,
	).length}`,
);
console.log(`no ways       ${L.filterStationsByLineProximity(stations, []).length}`);
console.log(`no stations   ${L.filterStationsByLineProximity([], ways).length}`);
console.log(`degenerate    ${L.filterStationsByLineProximity(stations, [{ wkt: "LINESTRING(0 0)" }]).length}`);
