#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for the two walk-anchored rail re-anchors
 * (`anchorTrainBoardingToWalkedStation` and `anchorTrainAlightToWalkedStation`
 * in `src/geo/passes/rail-absorbers.ts`), ported into
 * `Verified/Geo/RailAbsorbers.lean`.
 *
 * Both are `async` only because of their OSM lookups — stations near a fix,
 * lines at a point, stations on a line — and all three arrive as injected
 * functions, so the decisions port whole.
 *
 * The stubs answer at the fixtures' own coordinates, which are literals rather
 * than computed, so no `Float` has to survive being rendered as a string.
 *
 * Run: npx tsx lean/experiments/rail-anchors-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";

const here = path.dirname(fileURLToPath(import.meta.url));

type Fix = { ts: number; lat: number; lon: number; speed_kmh: number; bearing: number };
type Seg = Record<string, unknown>;

const fix = (ts: number, lat: number): Fix => ({ ts, lat, lon: -0.14, speed_kmh: 0, bearing: 0 });
/** An EAST-WEST fix: the same latitude throughout, so the haversine's two
 *  arguments cannot be swapped without the distance changing. */
const efix = (ts: number, lon: number): Fix => ({ ts, lat: 51.5, lon, speed_kmh: 0, bearing: 0 });

/** Most stations here sit on the -0.14 meridian, so a lookup mostly has to
 *  discriminate on latitude; the east-west fixture adds one that does not. */
type Stn = { name: string; subtype: string; distanceM: number; lat?: number; lon?: number };
const stationsAt = (lat: number, lon: number): Stn[] => {
	if (lon === -0.139) return [{ name: "Euston Square", subtype: "station", distanceM: 20 }];
	if (lon !== -0.14) return [];
	if (lat === 51.5006) return [{ name: "Euston Square", subtype: "station", distanceM: 20 }];
	if (lat === 51.5001) return [{ name: "Euston Square", subtype: "station", distanceM: 20 }];
	if (lat === 51.5028) return [{ name: "Great Portland Street", subtype: "station", distanceM: 25 }];
	if (lat === 51.5031) return [{ name: "Great Portland Street", subtype: "station", distanceM: 30 }];
	if (lat === 51.5059) return [{ name: "Baker Street", subtype: "station", distanceM: 15 }];
	return [];
};
const asked: string[] = [];
/** Most fixtures' stations carry no coordinates — the shape a recording made
 *  before `NearbyStation.lat`/`lon` existed replays as. The override supplies
 *  them where a case turns on the station's own position. */
let stationsOverride: ((lat: number, lon: number) => Stn[]) | null = null;
const stationsLookup = async (lat: number, lon: number) => {
	asked.push(`stations(${lat},${lon})`);
	return (stationsOverride ?? stationsAt)(lat, lon);
};

/** Directional and combined relation names on purpose: the intersection is
 *  taken over EXPANDED components, not the raw strings. */
const linesAt = (lat: number): string[] => {
	if (lat === 51.5) return ["Metropolitan Line Northbound"];
	if (lat === 51.5001) return ["Metropolitan Line"];
	if (lat === 51.5028) return ["Circle, Hammersmith & City and Metropolitan Lines"];
	if (lat === 51.5031) return ["Metropolitan Line"];
	if (lat === 51.5059) return ["Metropolitan Line"];
	return [];
};
let linesOverride: ((lat: number) => string[]) | null = null;
const linesLookup = async (lat: number, _lon: number) => {
	asked.push(`lines(${lat})`);
	return new Set((linesOverride ?? linesAt)(lat));
};

/** The served-station mirror: the Metropolitan stops at all three; the North
 *  London Line stops at none of them. The EMPTY line name answers a non-empty
 *  list that excludes every station here, so a caller that consults the mirror
 *  for a PRESENT-but-empty label gets a veto — which is how the `rail.line &&`
 *  truthiness test becomes observable. */
const servedLookup = async (line: string) => {
	asked.push(`served(${line})`);
	if (line === "Metropolitan Line")
		return [{ name: "Euston Square" }, { name: "Great Portland Street" }, { name: "Baker Street" }];
	if (line === "North London Line") return [{ name: "Finchley Road & Frognal" }, { name: "West Hampstead" }];
	if (line === "") return [{ name: "Nowhere" }];
	return [];
};

const MET = "Metropolitan Line";
const seg = (startTs: number, endTs: number, mode: TransportMode, over: Seg = {}): Seg => ({
	startTs,
	endTs,
	mode,
	pointCount: 10,
	...over,
});
const walk = (a: number, b: number, over: Seg = {}) => seg(a, b, "walking", over);
const train = (a: number, b: number, wayName: string | undefined, over: Seg = {}) =>
	seg(a, b, "train", { wayName, ...over });

const cell = (s: EnrichedSegment) => `${s.mode}[${s.startTs},${s.endTs}] ${s.wayName ?? "-"}`;

const showBoard = async (label: string, segs: Seg[], points: Fix[]) => {
	asked.length = 0;
	// The fixtures are deliberately PARTIAL — one documented conversion at the
	// boundary, rather than `as never` on every argument, which switched off
	// checking for the lookups too (#418).
	const out = await A.anchorTrainBoardingToWalkedStation(
		segs as unknown as EnrichedSegment[],
		points,
		stationsLookup,
		servedLookup,
	);
	console.log(`--- ${label}`);
	for (const s of out) console.log(`   ${cell(s)}`);
	for (const s of out) if (s.refinedReason) console.log(`   reason: ${s.refinedReason}`);
	if (asked.length) console.log(`   asked: ${asked.join(" ")}`);
};

const showAlight = async (label: string, segs: Seg[], points: Fix[]) => {
	asked.length = 0;
	const out = await A.anchorTrainAlightToWalkedStation(
		segs as unknown as EnrichedSegment[],
		points,
		[],
		stationsLookup,
		servedLookup,
	);
	console.log(`--- ${label}`);
	for (const s of out) console.log(`   ${cell(s)}`);
	for (const s of out) if (s.refinedReason) console.log(`   reason: ${s.refinedReason}`);
	if (asked.length) console.log(`   asked: ${asked.join(" ")}`);
};

console.log("=== step geometry (m) on the -0.14 meridian ===");
for (const [a, b] of [
	[51.5, 51.5003],
	[51.5, 51.5006],
	[51.5006, 51.502],
	[51.5006, 51.5048],
	[51.5, 51.5014],
	[51.5, 51.5028],
	[51.5, 51.5059],
	[51.5006, 51.5036],
	[51.5006, 51.5008],
] as const)
	console.log(`   ${a} -> ${b}: ${haversineMeters(a, -0.14, b, -0.14).toFixed(2)} m`);

/** slow, slow, then a two-step vehicle-paced run: the boarding hop. */
const boardWalk = [fix(0, 51.5), fix(60, 51.5003), fix(120, 51.5006), fix(150, 51.502), fix(180, 51.5034), fix(240, 51.5048)];
/** The same, but the run is ONE step long. */
const boardWalk1 = [fix(0, 51.5), fix(60, 51.5003), fix(120, 51.5006), fix(150, 51.5036), fix(210, 51.504)];
/** The hop returns to where it left: a GPS spike, not a relocation. */
const boardBounce = [fix(0, 51.5), fix(60, 51.5003), fix(120, 51.5006), fix(150, 51.5036), fix(210, 51.5008)];

console.log("\n=== anchorTrainBoardingToWalkedStation ===");
await showBoard("rename: the walk reached Euston Square", [walk(0, 240), train(240, 900, `Baker Street → Wembley Park · ${MET}`)], boardWalk);
await showBoard("same board: boundary still moves", [walk(0, 240), train(240, 900, `Euston Square → Wembley Park · ${MET}`)], boardWalk);
await showBoard("same board, ONE-step run: refused", [walk(0, 210), train(210, 900, `Euston Square → Wembley Park · ${MET}`)], boardWalk1);
await showBoard("rename on a ONE-step run: allowed", [walk(0, 210), train(210, 900, `Baker Street → Wembley Park · ${MET}`)], boardWalk1);
await showBoard("no line in the label", [walk(0, 240), train(240, 900, "Baker Street → Wembley Park")], boardWalk);
await showBoard("line cannot serve the station", [walk(0, 240), train(240, 900, "Baker Street → Wembley Park · North London Line")], boardWalk);
// The boarding veto is gated on `!sameBoard`: a same-station extension is not a
// rename, so an unserving line label does not stop it. Its ALIGHT twin orders
// the two the other way round — see the case below.
await showBoard("same board + unserving line: allowed", [walk(0, 240), train(240, 900, "Euston Square → Wembley Park · North London Line")], boardWalk);
await showBoard("hop bounces back: refused", [walk(0, 210), train(210, 900, `Baker Street → Wembley Park · ${MET}`)], boardBounce);
await showBoard("fewer than four fixes", [walk(0, 120), train(120, 900, `Baker Street → Wembley Park · ${MET}`)], boardWalk);
await showBoard("no vehicle-paced run at all", [walk(0, 120), train(120, 900, `Baker Street → Wembley Park · ${MET}`)], [fix(0, 51.5), fix(30, 51.5001), fix(60, 51.5002), fix(90, 51.5003)]);
await showBoard("unparseable label", [walk(0, 240), train(240, 900, MET)], boardWalk);
await showBoard("no label", [walk(0, 240), train(240, 900, undefined)], boardWalk);
await showBoard("previous is not a walk", [seg(0, 240, "stationary"), train(240, 900, `Baker Street → Wembley Park · ${MET}`)], boardWalk);
await showBoard("train → walk → train is an interchange", [train(-600, 0, `A → B · ${MET}`), walk(0, 240), train(240, 900, `Baker Street → Wembley Park · ${MET}`)], boardWalk);
await showBoard("…a STATIONARY two back does not block", [seg(-600, 0, "stationary"), walk(0, 240), train(240, 900, `Baker Street → Wembley Park · ${MET}`)], boardWalk);
await showBoard("effectiveMode on both sides", [walk(0, 240, { mode: "driving", refinedMode: "walking" }), train(240, 900, `Baker Street → Wembley Park · ${MET}`, { mode: "driving", refinedMode: "train" })], boardWalk);
await showBoard("window INCLUSIVE: tail fix at endTs", [walk(0, 239), train(239, 900, `Baker Street → Wembley Park · ${MET}`)], boardWalk);
await showBoard("existing refinedReason is appended to", [walk(0, 240), train(240, 900, `Baker Street → Wembley Park · ${MET}`, { refinedReason: "earlier note" })], boardWalk);
await showBoard("no station near the board fix", [walk(0, 240), train(240, 900, `Baker Street → Wembley Park · ${MET}`)], [fix(0, 51.4), fix(60, 51.4003), fix(120, 51.4006), fix(150, 51.402), fix(180, 51.4034), fix(240, 51.4048)]);

console.log("--- closing the probe sweep's silent gaps ---");
/** A duplicate timestamp inside what would otherwise be the hop: `dt > 0 ? … : 0`
 *  scores it 0, so the run never starts. */
const boardZeroDt = [fix(0, 51.5), fix(60, 51.5003), fix(120, 51.5006), fix(120, 51.5036), fix(210, 51.504)];
/** EAST-WEST: same latitude throughout. */
const boardEast = [efix(0, -0.14), efix(60, -0.1395), efix(120, -0.139), efix(150, -0.134), efix(210, -0.129)];
/** A qualifying run, a slow step, then a SECOND qualifying run. The `break`
 *  stops the scan at the first, so `hopRunSteps` stays 1 and a same-station
 *  extension is refused. */
const boardTwoRuns = [
	fix(0, 51.5), fix(60, 51.5003), fix(120, 51.5006), fix(150, 51.5036),
	fix(210, 51.5039), fix(240, 51.5053), fix(270, 51.5067),
];
/** A fast step too short to qualify, then a slow one, then another short fast
 *  step: only a STALE run start would let the second qualify. */
const boardStaleRun = [fix(0, 51.5006), fix(30, 51.502), fix(90, 51.5023), fix(120, 51.5037), fix(180, 51.504)];
/** Three fixes that would anchor if the four-fix bar were a three-fix bar. */
const boardThree = [fix(0, 51.5), fix(60, 51.5006), fix(90, 51.5036)];

await showBoard("zero-dt step scores 0, not infinity", [walk(0, 210), train(210, 900, `Baker Street → Wembley Park · ${MET}`)], boardZeroDt);
await showBoard("east-west: lat and lon are not swapped", [walk(0, 210), train(210, 900, `Baker Street → Wembley Park · ${MET}`)], boardEast);
await showBoard("the FIRST run wins and the scan stops", [walk(0, 270), train(270, 900, `Euston Square → Wembley Park · ${MET}`)], boardTwoRuns);
await showBoard("…and it renames on that same first run", [walk(0, 270), train(270, 900, `Baker Street → Wembley Park · ${MET}`)], boardTwoRuns);
await showBoard("a slow step resets the run start", [walk(0, 180), train(180, 900, `Baker Street → Wembley Park · ${MET}`)], boardStaleRun);
await showBoard("three fixes are not enough", [walk(0, 90), train(90, 900, `Baker Street → Wembley Park · ${MET}`)], boardThree);
/** The tail measures 344.7043 m — the only fixture whose fractional part crosses
 *  a half, so it is the one that tells `Math.round` from truncation. */
const boardHalf = [fix(0, 51.5), fix(60, 51.5003), fix(120, 51.5006), fix(150, 51.5036), fix(210, 51.5037)];
await showBoard("344.7 m rounds UP in the reason", [walk(0, 210), train(210, 900, `Baker Street → Wembley Park · ${MET}`)], boardHalf);
await showBoard("bare separator, same board: label kept", [walk(0, 240), train(240, 900, "Euston Square → Wembley Park · ")], boardWalk);
await showBoard("bare separator, rename: no suffix back", [walk(0, 240), train(240, 900, "Baker Street → Wembley Park · ")], boardWalk);

/** Leading two-step run, then it settles. */
const alightWalk = [fix(0, 51.5), fix(30, 51.5014), fix(60, 51.5028), fix(120, 51.5031), fix(180, 51.5034)];
/** TWO qualifying runs: the LAST one wins. */
const alightTwo = [fix(0, 51.5), fix(30, 51.5014), fix(60, 51.5028), fix(120, 51.5031), fix(150, 51.5045), fix(180, 51.5059)];
/** One long fast step — a tunnel blackout. */
const alight1 = [fix(0, 51.5), fix(30, 51.5028), fix(90, 51.5031)];

console.log("\n=== anchorTrainAlightToWalkedStation ===");
await showAlight("rename: the hop reached Great Portland St", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightWalk);
await showAlight("the LAST qualifying run wins", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightTwo);
await showAlight("same alight: boundary still moves", [train(-600, 0, `Wembley Park → Great Portland Street · ${MET}`), walk(0, 180)], alightWalk);
await showAlight("same alight, ONE-step run: refused", [train(-600, 0, `Wembley Park → Great Portland Street · ${MET}`), walk(0, 90)], alight1);
await showAlight("rename on a ONE-step run: allowed", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 90)], alight1);
await showAlight("no line in the label", [train(-600, 0, "Wembley Park → Euston Square"), walk(0, 180)], alightWalk);
await showAlight("line cannot serve the station", [train(-600, 0, "Wembley Park → Euston Square · North London Line"), walk(0, 180)], alightWalk);
// …and the ALIGHT twin applies its veto BEFORE deciding whether this is a
// rename, so an unserving line stops a same-station extension too.
await showAlight("same alight + unserving line: refused", [train(-600, 0, "Wembley Park → Great Portland Street · North London Line"), walk(0, 180)], alightWalk);
await showAlight("fewer than three fixes", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 30)], alightWalk);
await showAlight("no vehicle-paced run", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], [fix(0, 51.5), fix(60, 51.5003), fix(120, 51.5006)]);
await showAlight("unparseable label", [train(-600, 0, MET), walk(0, 180)], alightWalk);
await showAlight("next is not a walk", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), seg(0, 180, "stationary")], alightWalk);
await showAlight("train → walk → train is an interchange", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180), train(180, 600, `A → B · ${MET}`)], alightWalk);
await showAlight("…a STATIONARY two on does not block", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180), seg(180, 600, "stationary")], alightWalk);
await showAlight("effectiveMode on both sides", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`, { mode: "driving", refinedMode: "train" }), walk(0, 180, { mode: "driving", refinedMode: "walking" })], alightWalk);
await showAlight("existing refinedReason is appended to", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`, { refinedReason: "earlier note" }), walk(0, 180)], alightWalk);
await showAlight("no station at the settle fix", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], [fix(0, 51.4), fix(30, 51.4014), fix(60, 51.4028), fix(120, 51.4031)]);

console.log("--- closing the alight side's silent gaps ---");
/** Short fast, slow, short fast: only a STALE run start would qualify. */
const alightStaleRun = [fix(0, 51.5), fix(30, 51.5014), fix(90, 51.5017), fix(120, 51.5031)];
/** A long SLOW drift out and a fast return: the run covers 322 m but the walk
 *  ends 11 m from where it started, which is not a ride to anywhere. */
const alightBounce = [fix(0, 51.5), fix(600, 51.503), fix(630, 51.5001)];
/** Two fixes that would anchor if the three-fix bar were a two-fix bar. */
import * as A from "../../src/geo/passes/rail-absorbers.js";
import { haversineMeters } from "../../src/geo/place-snap.js";
import type { TransportMode } from "../../src/geo/segments.js";
const alightTwoFix = [fix(0, 51.5), fix(30, 51.5028)];

await showAlight("a slow step resets the run start (alight)", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 120)], alightStaleRun);
await showAlight("the walk must END away from the surfaced fix", [train(-600, 0, `Wembley Park → Great Portland Street · ${MET}`), walk(0, 630)], alightBounce);
await showAlight("two fixes are not enough", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 30)], alightTwoFix);
await showAlight("bare separator, same alight: label kept", [train(-600, 0, "Wembley Park → Great Portland Street · "), walk(0, 180)], alightWalk);
await showAlight("bare separator, rename: no suffix back", [train(-600, 0, "Wembley Park → Euston Square · "), walk(0, 180)], alightWalk);

console.log("--- the two ends must share a LINE ---");
linesOverride = (lat) => (lat === 51.5 ? ["Metropolitan Line"] : ["Jubilee Line"]);
await showAlight("no shared line: refused", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightWalk);
linesOverride = (lat) => (lat === 51.5 ? ["Metropolitan Line Southbound"] : ["Circle, Hammersmith & City and Metropolitan Lines"]);
await showAlight("shared only AFTER expansion", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightWalk);
linesOverride = () => [];
await showAlight("neither end knows a line: refused", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightWalk);
linesOverride = null;

console.log("--- an empty answer at the settle fix is not a disagreement ---");
// A platform is 150 m long and the depot beyond it longer: the settle fix
// (51.5028) lands past the platform ends, off every mapped rail way, so the
// point lookup answers NOTHING there while the station node it resolves to
// (51.5031) carries the line. Reading that empty answer as a disagreement is
// what left 07-07's ride tail inside the following walk.
const gptWithCoords: Stn = { name: "Great Portland Street", subtype: "station", distanceM: 25, lat: 51.5031, lon: -0.14 };
stationsOverride = (lat, lon) => (lon === -0.14 && lat === 51.5028 ? [gptWithCoords] : stationsAt(lat, lon));
linesOverride = (lat) => (lat === 51.5 || lat === 51.5031 ? [MET] : []);
await showAlight("empty at the fix: the STATION answers", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightWalk);
// The fallback asks a second question; it does not excuse the answer.
linesOverride = (lat) => (lat === 51.5 ? [MET] : []);
await showAlight("…and the station answering nothing is still a refusal", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightWalk);
// A station whose recording predates the coordinate fields cannot be asked at
// all, so the empty fix-point answer stands — the old behaviour, unchanged.
stationsOverride = null;
await showAlight("…and a station with no coordinates cannot be asked", [train(-600, 0, `Wembley Park → Euston Square · ${MET}`), walk(0, 180)], alightWalk);
linesOverride = null;
