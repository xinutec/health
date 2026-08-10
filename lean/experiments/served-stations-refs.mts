/**
 * V8 reference values for `Verified.Hsmm.ServedStations` (#672).
 *
 * Every function in `src/hmm/served-stations.ts` is EXPORTED, so unlike the rest
 * of the station-chain port these are driven DIRECTLY — no pinning through
 * `resolveStationChain`, no test-only exports. That makes this the one part of
 * the port whose guards are real V8 values today rather than after the resolver
 * lands.
 *
 * Cases are chosen to discriminate, one per decision the code makes:
 *   normalize        punctuation, case, digits, and a name that normalises empty
 *   relations        base-token stripping, ref vs name match, empty base
 *   set              the MIN_SERVED_STOPS floor, on both sides
 *   served           exact hit, the containment pattern it must ACCEPT
 *                    ("London St Pancras" ⊂ "…International"), and the one it
 *                    must REFUSE ("Euston" ⊂ "Euston Square", too short)
 *
 * Run: npx tsx lean/experiments/served-stations-refs.mts
 */

import type { RailStopRelation } from "../../src/geo/osm-rail-stops.js";
import {
	MIN_CONTAINMENT_CHARS,
	MIN_SERVED_STOPS,
	normalizeStationName,
	servedStationSet,
	stationNameServed,
} from "../../src/hmm/served-stations.js";

function rel(lineRef: string | null, lineName: string | null, stops: string[]): RailStopRelation {
	return {
		id: `rel/${lineRef ?? lineName ?? "anon"}`,
		lineRef,
		lineName,
		stops: stops.map((name) => ({ name, lat: 51.5, lon: -0.1 })),
	} as unknown as RailStopRelation;
}

console.log(`MIN_SERVED_STOPS=${MIN_SERVED_STOPS} MIN_CONTAINMENT_CHARS=${MIN_CONTAINMENT_CHARS}`);

console.log("\n-- normalizeStationName");
for (const n of [
	"King's Cross St. Pancras",
	"King's Cross St Pancras",
	"Euston Square",
	"Paddington (H&C Line)-Underground",
	"A1",
	"—",
]) {
	console.log(`  ${JSON.stringify(n)} -> ${JSON.stringify(normalizeStationName(n))}`);
}

// Five stops is exactly MIN_SERVED_STOPS, four is one short — the floor pinned
// from both sides, since ">= 5" and "> 5" agree on everything except this pair.
const FIVE = ["Aldgate", "Barbican", "Baker Street", "Euston Square", "Farringdon"];
const FOUR = FIVE.slice(0, 4);

const CASES: { label: string; relations: RailStopRelation[]; line: string }[] = [
	{ label: "ref match, 5 stops", relations: [rel("H&C", null, FIVE)], line: "H&C Line" },
	{ label: "name match, 5 stops", relations: [rel(null, "Hammersmith & City", FIVE)], line: "Hammersmith & City Line" },
	{ label: "5 stops but line unmatched", relations: [rel("H&C", null, FIVE)], line: "Victoria Line" },
	{ label: "matched, only 4 stops", relations: [rel("H&C", null, FOUR)], line: "H&C Line" },
	{
		label: "two relations union past the floor",
		relations: [rel("H&C", null, FOUR), rel("H&C", null, ["Great Portland Street"])],
		line: "H&C Line",
	},
	{ label: "empty base token matches nothing", relations: [rel("H&C", null, FIVE)], line: "Line" },
	{ label: "unnamed stops are skipped", relations: [rel("H&C", null, FIVE)], line: "h&c" },
];

console.log("\n-- servedStationSet (null, or sorted members)");
for (const c of CASES) {
	const s = servedStationSet(c.relations, c.line);
	const shown = s === null ? "null" : `{${[...s].sort().join(",")}}`;
	console.log(`  ${c.label.padEnd(34)} ${shown}`);
}

console.log("\n-- stationNameServed");
const served = servedStationSet([rel("TL", null, ["London St Pancras International", "Euston Square"])], "TL Line");
// That set is under the floor by design, so build the probe set directly from
// the same normalisation the real one uses.
const probe = new Set(
	["London St Pancras International", "Euston Square", "Aldgate", "Barbican", "Farringdon"].map(normalizeStationName),
);
console.log(`  (servedStationSet under the floor is ${served === null ? "null" : "NON-NULL"} — probe set built directly)`);
for (const name of [
	"Aldgate", // exact
	"aldgate", // exact after normalisation
	"London St Pancras", // containment, ACCEPTED: shorter is 17 chars
	"Euston", // containment, REFUSED: shorter is 6 chars
	"Euston Square", // exact, even though "Euston" alone is refused
	// REFUSED, and not for the reason it looks like: "barbicanstation" is 15
	// chars and clears the floor on its own, but the SET member "barbican" is 8.
	// The guard is on the shorter of the two, so a long candidate cannot reach a
	// short member however well it contains it.
	"Barbican Station",
	"Kings Cross", // absent
]) {
	console.log(`  ${name.padEnd(34)} ${stationNameServed(probe, name)}`);
}
