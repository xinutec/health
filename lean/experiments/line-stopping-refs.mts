#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `src/geo/line-stopping-pattern.ts` and the two
 * pure normalisers it reaches through (`lineBaseToken` in `line-stations.ts`,
 * `normalizeStationName` in `served-stations.ts`), ported to
 * `Verified/Geo/LineStoppingPattern.lean`.
 *
 * Run: npx tsx lean/experiments/line-stopping-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const L = await import(path.join(repo, "src/geo/line-stopping-pattern.ts"));
const LS = await import(path.join(repo, "src/geo/line-stations.ts"));
const SS = await import(path.join(repo, "src/hmm/served-stations.ts"));
const RC = await import(path.join(repo, "src/geo/rail-stops-cache.ts"));

// --- lineBaseToken: /\s+lines?\b.*$/i then trim -----------------------------
const BASE_CASES = [
	"Metropolitan Line",
	"Jubilee line: Stanmore → Stratford",
	"Circle and District lines",
	"Bakerloo",
	"Lines", // `\s+` is REQUIRED — no whitespace, no match
	"Line",
	"Northern linesman", // `\b` fails on both the greedy and backtracked arm
	"Docklands Light Railway", // shares only "li"
	"Metropolitan   Line", // greedy `\s+` spans the whole run
	"A Line B Line", // FIRST match wins, `.*$` eats the rest
	"   Metropolitan Line   ",
	" Line", // strips to empty
	"",
];
for (const s of BASE_CASES) console.log(`lineBaseToken ${JSON.stringify(s)}:`, JSON.stringify(LS.lineBaseToken(s)));

// --- normalizeStationName ---------------------------------------------------
for (const s of ["King's Cross St. Pancras", "Kings Cross St Pancras", "Euston Square", "  "]) {
	console.log(`normalizeStationName ${JSON.stringify(s)}:`, JSON.stringify(SS.normalizeStationName(s)));
}

// --- Fixture: the Wembley Park → Finchley Road stretch ----------------------
// The Metropolitan runs fast past Neasden, Dollis Hill, Willesden Green and
// Kilburn; the Jubilee calls at all four. Same rails, same fixes.
const stop = (name: string, seq: number) => ({ name, lat: 0, lon: 0, seq });
const rel = (lineRef: string | null, lineName: string | null, names: string[], id: number) => ({
	osmRelationId: id,
	routeType: "subway",
	lineRef,
	lineName,
	stops: names.map(stop),
});

const rels = [
	rel("Metropolitan", "Metropolitan Line: Aldgate → Amersham", ["Wembley Park", "Finchley Road", "Baker Street"], 1),
	rel(
		"Jubilee",
		"Jubilee Line: Stanmore → Stratford",
		["Wembley Park", "Neasden", "Dollis Hill", "Willesden Green", "Kilburn", "Finchley Road"],
		2,
	),
	// The same Metropolitan service mapped in the other direction.
	rel(null, "Metropolitan Line: Amersham → Aldgate", ["Baker Street", "Finchley Road", "Wembley Park"], 3),
] as never[];

for (const label of ["Metropolitan Line", "Jubilee Line", "Circle and District lines", " Line"]) {
	console.log(`railRelationsForLine ${JSON.stringify(label)}:`, RC.railRelationsForLine(rels, label).length);
}

const stops = (line: string, b: string, a: string) => L.intermediateStopCount(line, b, a, rels);
console.log("stops Met WP→FR:", stops("Metropolitan Line", "Wembley Park", "Finchley Road"));
console.log("stops Jub WP→FR:", stops("Jubilee Line", "Wembley Park", "Finchley Road"));
console.log("stops Met FR→WP:", stops("Metropolitan Line", "Finchley Road", "Wembley Park"));
console.log("stops Jub FR→WP:", stops("Jubilee Line", "Finchley Road", "Wembley Park"));
console.log("stops Jub normalized:", stops("Jubilee Line", "wembley  park!", "FINCHLEY ROAD"));
console.log("stops Victoria (no relation):", stops("Victoria Line", "Wembley Park", "Finchley Road"));
console.log("stops Met missing endpoint:", stops("Metropolitan Line", "Wembley Park", "Chesham"));
console.log("stops Jub same station:", stops("Jubilee Line", "Neasden", "Neasden"));
console.log("stops Met BS→FR (fewest wins):", stops("Metropolitan Line", "Baker Street", "Finchley Road"));

// --- stopBounds -------------------------------------------------------------
const fix = (ts: number, speed_kmh: number) => ({ ts, lat: 0, lon: 0, speed_kmh, bearing: 0 }) as never;

// The 2026-06-23 Wembley Park → Finchley Road shape from the module header,
// sampled at the ~15 s the real day had: a platform wait, 18.7 then 52-76 km/h
// unbroken with ONE 64 s gap, a deceleration, then arrival. t=0 is 07:42:28.
const ride0623 = [
	fix(0, 1.1), fix(15, 0.6), fix(30, 0.8), fix(45, 0.9), fix(60, 3.4),
	fix(75, 1.0), fix(90, 0.8), fix(105, 2.0), fix(112, 2.0), // platform wait
	fix(142, 18.7), // pulling away
	fix(157, 52), fix(172, 60), fix(187, 68), fix(202, 74), fix(217, 76),
	fix(232, 74), fix(247, 72), fix(262, 70), fix(277, 70), fix(292, 72),
	fix(307, 74), fix(322, 72),
	fix(386, 68), // the 64 s gap
	fix(401, 66), fix(416, 64), fix(431, 62), fix(446, 60), fix(461, 60),
	fix(476, 58), fix(491, 58), fix(506, 56), fix(521, 56),
	fix(536, 30), fix(551, 12), // braking into the platform
	fix(566, 0), fix(581, 0), fix(596, 0), fix(611, 0), fix(626, 0), // arrived
];
console.log("bounds 0623:", JSON.stringify(L.stopBounds(ride0623, 0, 631)));

// Never seen running / a single running fix: both null.
console.log("bounds neverRunning:", JSON.stringify(L.stopBounds([fix(0, 1), fix(60, 2)], 0, 60)));
console.log("bounds oneRunningFix:", JSON.stringify(L.stopBounds([fix(0, 1), fix(30, 40), fix(60, 2)], 0, 60)));

// A visible mid-ride pause between two running stretches: atLeast must see it.
const onePause = [
	fix(0, 40), fix(30, 40), fix(60, 2), fix(90, 1), fix(120, 40), fix(150, 40),
];
console.log("bounds onePause:", JSON.stringify(L.stopBounds(onePause, 0, 150)));

// A dense ride with no gaps at all: hidden capacity must be 0, so atMost === atLeast.
const dense = Array.from({ length: 12 }, (_, i) => fix(i * 5, 60));
console.log("bounds dense:", JSON.stringify(L.stopBounds(dense, 0, 55)));

// The same ride window with a long unobserved head — the "GPS came back
// halfway" case that must NOT read as a confidently non-stop ride.
console.log("bounds denseLateStart:", JSON.stringify(L.stopBounds(dense, -1800, 55)));

// Input order must not matter: mergeSort/TimSort are both stable.
console.log("bounds 0623 reversed:", JSON.stringify(L.stopBounds([...ride0623].reverse(), 0, 631)));

// --- pickLineByStoppingPattern ---------------------------------------------
const pick = (cands: string[], pts: unknown[], b: number, a: number) =>
	L.pickLineByStoppingPattern(cands, "Wembley Park", "Finchley Road", rels, pts as never, b, a);
console.log("pick Met vs Jub on 0623:", JSON.stringify(pick(["Metropolitan Line", "Jubilee Line"], ride0623, 0, 631)));
console.log("pick unmeasured rival:", JSON.stringify(pick(["Metropolitan Line", "Victoria Line"], ride0623, 0, 631)));
console.log("pick dark ride:", JSON.stringify(pick(["Metropolitan Line", "Jubilee Line"], [fix(0, 1), fix(631, 1)], 0, 631)));
console.log("pick sparse (both possible):", JSON.stringify(pick(["Metropolitan Line", "Jubilee Line"], dense, -1800, 55)));
console.log("pick dense tight:", JSON.stringify(pick(["Metropolitan Line", "Jubilee Line"], dense, 0, 55)));
console.log("pick single candidate:", JSON.stringify(pick(["Jubilee Line"], ride0623, 0, 631)));
