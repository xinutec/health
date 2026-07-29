#!/usr/bin/env node
// At a shared National-Rail/tube site, which station does the alight lookup
// offer — and which of those can the line actually serve? (#380.)
//
// `pickBestStation` ranks by tier then distance, so at King's Cross the mainline
// terminus node "London King's Cross" can outrank "King's Cross St Pancras" for
// a Victoria-line ride. This prints, for every captured `nearbyStations` answer
// containing the named station, the full candidate list with tier-relevant
// fields; then the `linesAtPoint` corridors recorded near them; then, per line,
// whether the mirror's membership list knows each candidate.
//
// The last section is here because it REFUTED the obvious fix. #380 proposed
// adjudicating the pair with `lineCannotServe`, but on 2026-05-15 the mirror's
// Metropolitan list contains BOTH "London King's Cross" and "King's Cross St
// Pancras" — exactly the over-inclusiveness `line-membership.ts` documents, and
// at a shared site it is total, so membership vetoes nothing. The corridors do
// separate them: the terminus node carries East Coast Main Line and Piccadilly,
// the tube node carries Victoria. Run both sections before believing either.
//
// Usage:
//   nix develop . --command node scripts/probe-alight-realisable.mjs <date> <station-substring>
import { readFileSync } from "node:fs";
import { parseCapturedDay } from "../dist/cli/fixture-day.js";

const [date, needle = "King's Cross"] = process.argv.slice(2);
const trace = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8")).inputs.osmTrace;

console.log(`\n=== ${date} · nearbyStations answers mentioning "${needle}" ===`);
for (const [key, stations] of Object.entries(trace.nearbyStations)) {
	if (!stations.some((s) => s.name?.includes(needle))) continue;
	console.log(`\n  ${key}`);
	for (const s of stations.slice(0, 8)) {
		console.log(`    ${s.distanceM.toFixed(0).padStart(4)} m  ${(s.subtype ?? "—").padEnd(16)} ${s.name}`);
	}
}

console.log(`\n=== linesAtPoint answers within 600 m of each nearbyStations key above ===`);
const meters = (aLat, aLon, bLat, bLon) => {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
};
const anchors = Object.entries(trace.nearbyStations)
	.filter(([, ss]) => ss.some((s) => s.name?.includes(needle)))
	.map(([k]) => k.split("|").map(Number));
for (const [key, lines] of Object.entries(trace.linesAtPoint)) {
	const [lat, lon] = key.split("|").map(Number);
	const near = anchors.some(([aLat, aLon]) => meters(aLat, aLon, lat, lon) <= 600);
	if (!near) continue;
	console.log(`  ${key.padEnd(46)} ${lines.join(" | ") || "(empty)"}`);
}

const names = new Set();
for (const stations of Object.values(trace.nearbyStations)) {
	for (const s of stations) if (s.name?.includes(needle)) names.add(s.name);
}

console.log(`\n=== membership (stationsOnLine) for the "${needle}" candidates ===`);
const norm = (s) => s.trim().toLowerCase();
for (const [line, served] of Object.entries(trace.stationsOnLine ?? {})) {
	const hits = [...names].filter((n) => served.some((s) => norm(s.name) === norm(n)));
	console.log(`  ${line.padEnd(48)} ${served.length.toString().padStart(3)} stations → ${hits.join(", ") || "none"}`);
}
